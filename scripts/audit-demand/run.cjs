// Local transpilation avoids tsx's user-info lookup in restricted Windows sessions.
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = function(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});
  module._compile(output.outputText, filename);
};
require('./compare.ts');
