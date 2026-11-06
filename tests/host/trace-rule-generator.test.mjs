// Optional development tool: the deployed collector has no Node dependency.
import {describe,it,expect} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
describe('development trace-rule generator',()=>{
  it('retains delegated topology identity and execution scopes',()=>{
    const root=mkdtempSync(join(tmpdir(),'pilot-trace-rules-'));
    try{
      const spec=join(root,'spec.md'),output=join(root,'rules.json');
      writeFileSync(spec,'# Agent\n## Attributes\n');
      execFileSync(process.execPath,[fileURLToPath(new URL('../../scripts/update-validation-rules.mjs',import.meta.url)),'--spec-file',spec,'--output',output],{timeout:10000,stdio:'pipe'});
      const actual=JSON.parse(readFileSync(output,'utf8'));
      const expected=JSON.parse(readFileSync(new URL('../../docs/trace-validation-rules.json',import.meta.url),'utf8'));
      expect(actual.version).toBe(expected.version);
      for(const kind of ['ENTRY','AGENT','TOOL']){
        const {attributes:actualAttrs,...actualMeta}=actual.spanKinds[kind];
        const {attributes:expectedAttrs,...expectedMeta}=expected.spanKinds[kind];
        expect(actualMeta).toEqual(expectedMeta);
      }
      expect(actual.timeRules).toEqual(expected.timeRules);
      expect(actual.semanticRules).toEqual(expected.semanticRules);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});
