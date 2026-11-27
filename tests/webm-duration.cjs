const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('child_process');
const vm = require('vm');
const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const first = html.indexOf('// ---------- Recording format and WebM metadata ----------');
const last = html.indexOf('    function updateDockForState()', first);
assert.ok(first >= 0 && last > first, 'Media helpers must be reachable in index.html');
const fix = vm.runInNewContext(html.slice(first, last) + '\nfixWebmDuration', {
  Blob, Uint8Array, DataView, TextDecoder
});
const temp = mkdtempSync(join(tmpdir(), 'teleprompter-webm-'));
process.chdir(temp);
console.log('WebM test files:', temp);
const meta = file => JSON.parse(execFileSync('ffprobe', ['-v','error','-show_entries','format=duration,start_time:stream=codec_name,codec_type','-of','json',file],{encoding:'utf8'}));
async function main() {
  for (const [name, opts] of [
    ['indexed',[]], ['live',['-live','1']], ['bootclock',['-live','1','-output_ts_offset','10800']],
    ['legitimate-offset',['-live','1','-output_ts_offset','0.12']]
  ]) {
    const src = 'fixture-'+name+'.webm', dst = 'fixture-'+name+'-fixed.webm';
    execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=size=160x120:rate=25','-f','lavfi','-i','sine=frequency=1000:sample_rate=48000','-t','30','-threads','2','-c:v','libvpx','-b:v','180k','-c:a','libopus',...opts,src]);
    const input = new Blob([readFileSync(src)],{type:'video/webm'});
    const out = await fix(input,30000);
    assert.equal(out.hasAudio,true);
    writeFileSync(dst,Buffer.from(await out.blob.arrayBuffer()));
    const before = meta(src), after = meta(dst);
    const start = Number(after.format.start_time);
    const target = name === 'legitimate-offset' ? 30.12 : 30;
    assert.ok(Math.abs(Number(after.format.duration) - target) <= .06,JSON.stringify({before,after,target,out:out.durationMs}));
    if(name === 'legitimate-offset') assert.ok(start > .08);
    if(name === 'bootclock') assert.ok(Math.abs(start) < .03);
    const interval = JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-read_intervals','25%+0.1','-show_entries','packet=pts_time','-of','json',dst],{encoding:'utf8'}));
    assert.ok(interval.packets.length, dst + ' seek');
    console.log(name,before.format,after.format,'metadata',out.durationMs);
  }
  await assert.rejects(fix(new Blob([new Uint8Array([0x1a,0x45,0xdf,0xa3,0xff])]),30000));
}
main().catch(err=>{console.error(err);process.exitCode=1});

