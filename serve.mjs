import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from './games/ai-snake/server.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(root, 'web/public/ai-snake');
const api = await createServer({dataDir: path.join(root, 'data/ai-snake')});
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json'};
const server = http.createServer((req,res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/ai-snake/')) {
    const upstream = http.request(api.url + req.url.slice('/api/ai-snake'.length), {method:req.method,headers:{'content-type':'application/json'}}, response => {
      res.writeHead(response.statusCode, {'content-type':'application/json','cache-control':'no-store'}); response.pipe(res);
    });
    upstream.on('error',()=>{if(!res.headersSent) res.writeHead(502);res.end();}); req.pipe(upstream); return;
  }
  let filename;
  try { filename = path.resolve(web, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)); }
  catch { res.writeHead(400);res.end();return; }
  if (!filename.startsWith(web + path.sep)) {res.writeHead(404);res.end();return;}
  fs.stat(filename,(error, stat)=>{
    if(error || !stat.isFile()){res.writeHead(404);res.end();return;}
    res.writeHead(200, {'content-type':mime[path.extname(filename)] || 'application/octet-stream','cache-control':'no-store'});
    const stream=fs.createReadStream(filename);stream.on('error',()=>res.destroy());stream.pipe(res);
  });
});
server.listen(Number(process.env.AI_SNAKE_WEB_PORT || 8790), process.env.AI_SNAKE_HOST || '127.0.0.1',()=>console.log('AI Snake web server ready'));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
  server.closeAllConnections();api.server.closeAllConnections();
  server.close(()=>api.server.close(()=>process.exit(0)));
});
