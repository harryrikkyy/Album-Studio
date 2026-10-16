'use strict'
const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const req=JSON.parse(line);if(req.params.exit)process.exit(0);setTimeout(()=>process.stdout.write(JSON.stringify({id:req.id,ok:true,result:{pong:true}})+'\n'),200)})
