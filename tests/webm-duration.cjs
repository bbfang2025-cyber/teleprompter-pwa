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
const { fixWebmDuration: fix, inspectMp4 } = vm.runInNewContext(html.slice(first, last) + '\n({fixWebmDuration, inspectMp4})', {
  Blob, Uint8Array, DataView, TextDecoder
});
const temp = mkdtempSync(join(tmpdir(), 'teleprompter-webm-'));
process.chdir(temp);
console.log('WebM test files:', temp);
const meta = file => JSON.parse(execFileSync('ffprobe', ['-v','error','-show_entries','format=duration,start_time:stream=codec_name,codec_type','-of','json',file],{encoding:'utf8'}));
async function main() {
  for (const [name, opts] of [
    ['indexed',[]], ['live',['-live','1']], ['bootclock',['-live','1','-output_ts_offset','10800']],
    ['8000-minute-clock',['-live','1','-output_ts_offset','480000']],
    ['legitimate-offset',['-live','1','-output_ts_offset','0.12']]
  ]) {
    const src = 'fixture-'+name+'.webm', dst = 'fixture-'+name+'-fixed.webm';
    execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=size=160x120:rate=25','-f','lavfi','-i','sine=frequency=1000:sample_rate=48000','-t','30','-threads','2','-c:v','libvpx','-b:v','180k','-c:a','libopus',...opts,src]);
    const data = readFileSync(src);
    if (name === 'indexed') {
      const durationTag = data.indexOf(Buffer.from([0x44, 0x89, 0x88]));
      assert.ok(durationTag >= 0 && durationTag < 512);
      data.writeDoubleBE(480000000, durationTag + 3);
      writeFileSync(src, data);
    }
    const input = new Blob([data],{type:'video/webm'});
    const out = await fix(input,30000);
    assert.equal(out.hasAudio,true);
    writeFileSync(dst,Buffer.from(await out.blob.arrayBuffer()));
    const before = meta(src), after = meta(dst);
    const start = Number(after.format.start_time);
    const target = name === 'legitimate-offset' ? 30.12 : 30;
    assert.ok(Math.abs(Number(after.format.duration) - target) <= .06,JSON.stringify({before,after,target,out:out.durationMs}));
    if(name === 'legitimate-offset') assert.ok(start > .08);
    if(name === 'bootclock' || name === '8000-minute-clock') assert.ok(Math.abs(start) < .03);
    const interval = JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-read_intervals','25%+0.1','-show_entries','packet=pts_time','-of','json',dst],{encoding:'utf8'}));
    assert.ok(interval.packets.length, dst + ' seek');
    console.log(name,before.format,after.format,'metadata',out.durationMs);
  }
  for (const ext of ['webm','mp4']) {
    const file='audio-only-tail.'+ext;
    const codecs=ext==='mp4' ? ['-c:v','libx264','-c:a','aac','-movflags','frag_keyframe+empty_moov'] :
      ['-c:v','libvpx','-c:a','libopus'];
    execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=size=160x120:rate=25:duration=15',
      '-f','lavfi','-i','sine=frequency=1000:sample_rate=48000:duration=30','-threads','2',...codecs,file]);
    const blob=new Blob([readFileSync(file)],{type:'video/'+ext});
    const check=ext==='mp4' ? await inspectMp4(blob) : await fix(blob,30000);
    assert.equal(check.videoTailMissing,true,ext+' must flag an audio-only tail');
    console.log(ext,'15s video and 30s audio detected');
  }
  await assert.rejects(fix(new Blob([new Uint8Array([0x1a,0x45,0xdf,0xa3,0xff])]),30000));
}
main().catch(err=>{console.error(err);process.exitCode=1});

