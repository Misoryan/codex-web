const fs = require('node:fs'), path = require('node:path');
const source = path.resolve(process.argv[2] || 'scratch/ChatGPT.app/Contents/Resources');
const target = path.resolve(process.argv[3] || 'scratch/asar');
const runtime = path.join(source, 'cua_node');
if (!fs.existsSync(path.join(runtime, 'manifest.json'))) throw Error('Official browser runtime is missing');
fs.cpSync(runtime, path.join(target, 'cua_node'), {recursive:true});
console.log('Official browser runtime bundled');
