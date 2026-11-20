#!/usr/bin/env node
'use strict';
// jsobf_stage.js — Stage khusus untuk javascript-obfuscator (SIPHASH + string table + CFF)
const fs=require('fs'),vm=require('vm');
const parser=require('@babel/parser');
const traverse=require('@babel/traverse').default;
const generate=require('@babel/generator').default;

const IN=process.argv[2], OUT=process.argv[3];
if(!IN||!OUT){ console.error('usage: node jsobf_stage.js in.js out.js'); process.exit(1); }
const src=fs.readFileSync(IN,'utf8');

let ast;
try{
  ast=parser.parse(src,{sourceType:'script',allowReturnOutsideFunction:true,allowAwaitOutsideFunction:true,allowHashBang:true,errorRecovery:true,plugins:['jsx']});
}catch(e){ console.error('parse fail: '+e.message.slice(0,100)); process.exit(1); }

const topFnNames=[];
for(const n of ast.program.body) if(n.type==='FunctionDeclaration'&&n.id) topFnNames.push(n.id.name);

let arrName=null, arrLen=0, strName=null, strLen=0;
for(const n of ast.program.body){
  if(n.type==='VariableDeclaration') for(const d of n.declarations){
    if(!d.init) continue;
    if(d.init.type==='ArrayExpression' && d.init.elements.length>100){ arrName=d.id.name; arrLen=d.init.elements.length; }
    if(d.init.type==='StringLiteral' && d.init.value.length>50000){ strName=d.id.name; strLen=d.init.value.length; }
  }
  if(n.type==='ExpressionStatement'&&n.expression.type==='AssignmentExpression'){
    const e=n.expression;
    if(e.left.type==='Identifier'&&e.right.type==='StringLiteral'&&e.right.value.length>50000){ strName=e.left.name; strLen=e.right.value.length; }
  }
}
if(!strName){ console.error('no string table found'); process.exit(1); }
console.log('  [jsobf] string table: '+strName.slice(0,18)+' ('+strLen+' chars)');
if(arrName) console.log('  [jsobf] const array: '+arrName.slice(0,18)+' ('+arrLen+' elems)');

let decName = process.env.JSOBF_DEC || null;
if(!decName){
  const guardCalls=[];
  for(const n of ast.program.body){
    if(n.type!=='IfStatement') continue;
    const t=src.slice(n.test.start,n.test.end);
    for(const m of t.matchAll(/([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\(\d+\s*,\s*[^\s,()]+\[[^\]]+\]\)/g))
      if(topFnNames.includes(m[1]) && !guardCalls.includes(m[1])) guardCalls.push(m[1]);
  }
  if(guardCalls.length) decName = guardCalls[0];
}
if(!decName){
  for(const n of ast.program.body){
    if(n.type!=='FunctionDeclaration'||!n.id) continue;
    const body = src.slice(n.start, n.end);
    if(body.includes(strName+'[') && body.includes('g3ce')){
      if(body.length < 3000){ decName = n.id.name; break; }
    }
  }
}
if(!decName){
  decName = topFnNames.find(n => n.length>=10 && /[Ѐ-ӿ]/.test(n) && src.includes('function '+n)) || topFnNames[0];
}
console.log('  [jsobf] decoder fn: '+decName.slice(0,28));

const initNodes=[];
for(let i=0;i<ast.program.body.length;i++){
  const n=ast.program.body[i];
  if(n.type==='IfStatement') break;
  initNodes.push(n);
}
const initSrc=initNodes.map(node=>src.slice(node.start,node.end).replace(/^const\s+/,'var ')).join('\n');
const initAst=parser.parse(initSrc,{sourceType:'script',allowReturnOutsideFunction:true,allowAwaitOutsideFunction:true,allowHashBang:true,errorRecovery:true,plugins:['jsx']});
traverse(initAst,{
  CallExpression(path){
    if(path.node.callee.type==='Identifier'&&path.node.callee.name==='eval'){
      const arg=path.node.arguments[0];
      if(arg&&arg.type==='StringLiteral'){
        try{const sub=parser.parse('('+arg.value+')',{sourceType:'script'});path.replaceWith(sub.program.body[0].expression);}
        catch(e){path.replaceWith({type:'UnaryExpression',operator:'void',prefix:true,argument:{type:'NumericLiteral',value:0}});}
      }else{path.replaceWith({type:'UnaryExpression',operator:'void',prefix:true,argument:{type:'NumericLiteral',value:0}});}
    }
  },
  WhileStatement(path){
    if(path.node.test.type==='BooleanLiteral'&&path.node.test.value===true)
      path.replaceWith({type:'ForStatement',init:null,test:null,update:null,body:{type:'BlockStatement',body:[{type:'BreakStatement'}]}});
  },
  DebuggerStatement(path){path.remove();}
});
const initCode=generate(initAst,{compact:false,comments:false}).code;

const sandbox={
  console:{log(){},error(){},warn(){}},Buffer,TextDecoder,TextEncoder,Uint8Array,
  atob:s=>Buffer.from(s,'base64').toString('binary'),btoa:s=>Buffer.from(s,'binary').toString('base64'),
  setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},require:()=>({}),module:{exports:{}},
};
// pre-set globals used by init
sandbox['m3bbggkscdd28a7ac752e7']=TextDecoder;
sandbox['n3bdgmtfmdіl3a9073c0663217']=Buffer;
sandbox['u3bсkуby2de6fece1b33b0']=Uint8Array;
const ctx=vm.createContext(sandbox);

// stub all fns
for(const n of topFnNames) if(!(n in sandbox)) sandbox[n]=function(){};

// override g49cku (nama yg ada "cku")
for(const k of Object.keys(sandbox)){ if(/^g\d+cku/.test(k)){ sandbox[k]=function(){}; } }
sandbox['g49ckuуqѕ91216110308873']=function(){};

for(const node of ast.program.body){
  if(node.type==='VariableDeclaration') for(const d of node.declarations){
    if(d.init&&d.id.name===arrName&&d.init.type==='ArrayExpression')
      try{vm.runInContext('var '+arrName+'='+src.slice(d.init.start,d.init.end)+';',ctx,{timeout:5000});}catch(e){}
  }
  if(node.type==='ExpressionStatement'&&node.expression.type==='AssignmentExpression'){
    const e=node.expression;
    if(e.left.name===strName&&e.right.type==='StringLiteral')
      try{vm.runInContext('var '+strName+'='+src.slice(e.right.start,e.right.end)+';',ctx,{timeout:5000});}catch(e){}
  }
}

try{vm.runInContext(initCode,ctx,{timeout:90000,displayErrors:false});console.log('  [jsobf] init complete');}
catch(e){console.log('  [jsobf] init timeout');}

// reload A, B
for(const node of ast.program.body){
  if(node.type==='VariableDeclaration') for(const d of node.declarations){
    if(d.init&&d.id.name===arrName&&d.init.type==='ArrayExpression')
      try{vm.runInContext('var '+arrName+'='+src.slice(d.init.start,d.init.end)+';',ctx,{timeout:5000});}catch(e){}
  }
  if(node.type==='ExpressionStatement'&&node.expression.type==='AssignmentExpression'){
    const e=node.expression;
    if(e.left.name===strName&&e.right.type==='StringLiteral')
      try{vm.runInContext('var '+strName+'='+src.slice(e.right.start,e.right.end)+';',ctx,{timeout:5000});}catch(e){}
  }
}

// Inline
const litStr = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"`;
const litNum = String.raw`0x[0-9a-fA-F]+|\d+(?:\.\d+)?`;
const arrLk = String.raw`[^\s(),;{}\[\]]+\[[^\]]+\]`;
const elem = '(?:'+litNum+'|'+litStr+'|'+arrLk+')';
const argsP = elem+'(?:\\s*,\\s*'+elem+')*';
// smoke test
try{
  const probe = vm.runInContext(decName+'(1872,'+(arrName?arrName+'[13]':'12')+')',ctx,{timeout:5000,displayErrors:false});
  console.log('  [jsobf] probe: '+JSON.stringify(probe));
}catch(e){ console.log('  [jsobf] probe ERR: '+e.message.slice(0,120)); }
const re = new RegExp('(?<![.\\w$])'+decName.replace(/\$/g,'\\$')+'\\('+argsP+'\\)','g');
let out=src, n=0;
const cache=new Map();
out=out.replace(re,(full)=>{
  if(cache.has(full))return cache.get(full);
  try{const v=vm.runInContext(full,ctx,{timeout:500,displayErrors:false});
    if(typeof v==='string'&&v.length>0){n++;const rep=JSON.stringify(v);cache.set(full,rep);return rep;}}catch(e){}
  cache.set(full,full);return full;
});
console.log('  [jsobf] decoder inline: '+n+' calls');
fs.writeFileSync(OUT,out);
console.log('  [jsobf] output: '+out.length+' bytes');
