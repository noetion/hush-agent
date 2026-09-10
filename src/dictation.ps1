param([string]$WavePath,[string]$StopFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
# Dictation runs until Hush says stop rather than ending after one phrase, so a long
# thought is not cut off mid-sentence. Each phrase is written as it is recognised, so
# what has already been said survives even if this process is killed outright.
#
# Stopping is a file rather than a signal: Hush creates $StopFile, we notice within a
# second and call RecognizeAsyncStop, which finalises the phrase still being spoken
# instead of discarding it. The cap is a backstop for a microphone left open, not a
# limit anyone should reach.
$cap=[TimeSpan]::FromMinutes(30)
$grace=[TimeSpan]::FromSeconds(5)
try {
 $recognizer=[System.Speech.Recognition.SpeechRecognitionEngine]::new()
 $recognizer.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
 if($WavePath){$recognizer.SetInputToWaveFile($WavePath)}else{$recognizer.SetInputToDefaultAudioDevice()}
 # Handlers run in their own runspace and their output never reaches our stdout, so
 # queue the events and emit from this thread only.
 [void](Register-ObjectEvent -InputObject $recognizer -EventName SpeechRecognized -SourceIdentifier hushSpeech)
 [void](Register-ObjectEvent -InputObject $recognizer -EventName RecognizeCompleted -SourceIdentifier hushDone)
 $recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
 Write-Output '{"type":"ready"}'
 [Console]::Out.Flush()

 $deadline=(Get-Date).Add($cap)
 $stopping=$false; $said=$false; $done=$false
 while(-not $done){
  $event=Wait-Event -Timeout 1
  if($event){
   if($event.SourceIdentifier -eq 'hushSpeech'){
    $text=$event.SourceEventArgs.Result.Text
    if($text){@{type='text';text=$text} | ConvertTo-Json -Compress;[Console]::Out.Flush();$said=$true}
   } elseif($event.SourceIdentifier -eq 'hushDone'){$done=$true}
   Remove-Event -EventIdentifier $event.EventIdentifier
  }
  if(-not $stopping){
   $asked=$StopFile -and (Test-Path -LiteralPath $StopFile)
   if($asked -or (Get-Date) -ge $deadline){
    # Finalise rather than abandon: the phrase in flight is usually the reason to stop.
    $recognizer.RecognizeAsyncStop();$stopping=$true;$deadline=(Get-Date).Add($grace)
   }
  } elseif((Get-Date) -ge $deadline){$done=$true}
 }
 if(-not $said){Write-Output '{"type":"empty"}'}
} catch {@{type='error';message=$_.Exception.Message} | ConvertTo-Json -Compress;exit 1}
finally {
 Unregister-Event -SourceIdentifier hushSpeech -ErrorAction SilentlyContinue
 Unregister-Event -SourceIdentifier hushDone -ErrorAction SilentlyContinue
 if($recognizer){$recognizer.Dispose()}
}
