const cases=[
 ['model empty string',{model:'',messages:[{role:'user',content:'ping'}],max_tokens:16}],
 ['model omitted',{messages:[{role:'user',content:'ping'}],max_tokens:16}],
 ['model missing tag qwen3.5',{model:'qwen3.5',messages:[{role:'user',content:'ping'}],max_tokens:16}],
 ['role bogus tool',{model:'qwen3.5:9b',messages:[{role:'tool',content:'ping'}],max_tokens:16}],
 ['max_tokens as string',{model:'qwen3.5:9b',messages:[{role:'user',content:'ping'}],max_tokens:'4096'}],
];
(async()=>{for(const [n,b] of cases){try{const r=await fetch('http://127.0.0.1:11434/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const t=await r.text();console.log('[stat '+r.status+'] '+n+' :: '+t.slice(0,220).replace(/\n/g,' '));}catch(e){console.log('[ERR ] '+n+' :: '+e.message);}}})();