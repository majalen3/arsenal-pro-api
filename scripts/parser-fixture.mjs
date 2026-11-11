// Isolated parser-only process: loopback ephemeral port, no DB/account/server import.
import express from 'express';
const app=express();app.use(express.json({limit:'20kb'}));
app.get('/health',(_q,r)=>r.json({ok:true}));app.post('/parse',(q,r)=>r.json(q.body));
app.use((e,_q,r,_n)=>r.status(e.type==='entity.too.large'?413:400).json({error:'invalid body'}));
const server=app.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
process.on('message',m=>{if(m==='stop')server.close(()=>process.exit(0));});
