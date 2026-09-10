// The parked-position guard decides whether a remembered position is still usable.
// It is exercised against the shipped source so the test cannot drift from it.
const test=require('node:test');const assert=require('node:assert');
const fs=require('node:fs');const path=require('node:path');

const source=fs.readFileSync(path.join(__dirname,'../src/main.cjs'),'utf8');
const declaration=source.match(/function reachable\([^]*?\n\}/);
assert.ok(declaration,'reachable() not found in src/main.cjs');
const build=displays=>new Function('screen',`${declaration[0]}\nreturn reachable;`)({getAllDisplays:()=>displays});

const laptop=[{workArea:{x:0,y:0,width:1920,height:1040}}];
const dual=[{workArea:{x:0,y:0,width:1920,height:1040}},{workArea:{x:1920,y:0,width:2560,height:1400}}];
const WIDTH=390;

test('a position inside the work area is reachable',()=>{
  assert.equal(build(laptop)(1514,16,WIDTH),true);
});

test('a position on a display that is no longer attached is not reachable',()=>{
  const parkedOnSecondScreen=[2200,300];
  assert.equal(build(dual)(...parkedOnSecondScreen,WIDTH),true);
  assert.equal(build(laptop)(...parkedOnSecondScreen,WIDTH),false);
});

test('the draggable header stays grabbable near either edge',()=>{
  const reachable=build(laptop);
  // Dragged mostly off the left: fewer than 80px of panel left on screen.
  assert.equal(reachable(-330,500,WIDTH),false);
  assert.equal(reachable(-300,500,WIDTH),true);
  // Dragged mostly off the right.
  assert.equal(reachable(1840,500,WIDTH),true);
  assert.equal(reachable(1841,500,WIDTH),false);
});

test('a position below the work area is not reachable',()=>{
  const reachable=build(laptop);
  assert.equal(reachable(800,999,WIDTH),true);
  assert.equal(reachable(800,1000,WIDTH),false);
  assert.equal(reachable(800,-1,WIDTH),false);
});
