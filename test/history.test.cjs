const test=require('node:test'),assert=require('node:assert/strict');
const {History,codexMessages,claudeMessages}=require('../src/history.cjs');
test('history shows user/agent content without exposing tool payloads',()=>{
 const result=codexMessages({turns:[{items:[{id:'u',type:'userMessage',content:[{type:'text',text:'Question'},{type:'image',url:'private'}]},{id:'t',type:'commandExecution',text:'secret stdout'},{id:'a',type:'agentMessage',text:'Answer'}]}]});
 assert.deepEqual(result.map(m=>m.text),['Question','Answer']);assert.deepEqual(result.map(m=>m.role),['you','agent']);
});
test('Claude history ignores subagent messages and retains supported text blocks',()=>{
 const result=claudeMessages([{type:'assistant',uuid:'a',parent_tool_use_id:'tool',message:{content:'subagent'}},{type:'user',uuid:'u',message:{content:'hello'}},{type:'assistant',uuid:'r',message:{content:[{type:'tool_use',input:{secret:1}},{type:'text',text:'world'}]}}]);
 assert.deepEqual(result.map(m=>m.text),['hello','world']);
});
test('task IDs must come from discovery before history is accessed',async()=>{const h=new History(process.cwd());await assert.rejects(h.read('codex','arbitrary'),/choose a listed conversation/);h.close();});

// The task catalog grew for the life of the process. It only needs the recent
// listings, since its job is to confirm a chosen conversation was one Hush listed.
test('the task catalog keeps the most recent listings and no more',()=>{
  const {History}=require('../src/history.cjs');
  const history=new History(require('node:os').tmpdir());
  history.catalogLimit=5;
  for(let i=0;i<50;i++)history.remember({provider:'codex',sourceId:'task-'+i,title:'Task '+i});
  assert.equal(history.catalog.size,5,'the catalog must stay bounded');
  assert.ok(history.catalog.has('codex:task-49'),'the newest listing must be kept');
  assert.ok(!history.catalog.has('codex:task-0'),'the oldest must have been dropped');
});

test('re-listing a conversation refreshes it rather than filling the catalog',()=>{
  const {History}=require('../src/history.cjs');
  const history=new History(require('node:os').tmpdir());
  history.catalogLimit=3;
  history.remember({provider:'codex',sourceId:'a',title:'first'});
  history.remember({provider:'codex',sourceId:'b',title:'b'});
  history.remember({provider:'codex',sourceId:'c',title:'c'});
  history.remember({provider:'codex',sourceId:'a',title:'second'});
  assert.equal(history.catalog.size,3);
  assert.equal(history.catalog.get('codex:a').title,'second','the entry should be updated');
  assert.ok(history.catalog.has('codex:a'),'and kept as the most recent');
});
