const { chromium, webkit } = require('playwright');
const { createServer } = require('http');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const html = readFileSync(join(__dirname, '..', 'index.html'));
const temp = mkdtempSync(join(tmpdir(), 'teleprompter-browser-'));
process.chdir(temp);
console.log('Browser test files:', temp);
const server = createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}).end(html);
  if (req.url === '/blank') return res.end('<title>Blank</title>');
  res.writeHead(204).end();
});

async function test() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const address = 'http://127.0.0.1:' + server.address().port + '/';
  const useWebKit = process.argv.includes('--webkit');
  const browser = useWebKit ? await webkit.launch() : await chromium.launch({
    channel: 'chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
  });
  process.on('unhandledRejection', error => { console.error(error); process.exitCode = 1; });
  async function pageSetup(variant = '', width = 390, height = 844) {
    const context = await browser.newContext({
      viewport: {width,height}, isMobile: true, hasTouch: true, acceptDownloads: true,
      userAgent: (useWebKit ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 Version/18.4 Mobile/15E148 Safari/604.1' : 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36') + (variant === 'ui' ? ' MicroMessenger' : '')
    });
    if (useWebKit) await context.grantPermissions(['camera','microphone']);
    await context.addInitScript(({variant,useWebKit}) => {
      window.r = { calls: [], tracks: [], locks: [], speech: [], sharing: [], urls: [], revoked: [], mode: 'ok' };
      if (variant === 'brokenStorage') {
        localStorage.setItem('tp_pwa_scripts_v1', '[null,{},{"id":"good","body":"正文","title":12}]');
        localStorage.setItem('tp_pwa_settings_v1', '{"speed":"junk","fontSize":"nan","winRect":{"x":1},"voiceFollow":"false"}');
      }
      if (!navigator.mediaDevices) return;
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async settings => {
        r.calls.push(Boolean(settings.audio));
        if (r.mode === 'denyAll' || (settings.audio && r.mode === 'denyAudio')) throw new DOMException('denied', 'NotAllowedError');
        const media = await orig(settings);
        r.tracks.push(...media.getTracks());
        if (settings.audio && r.mode === 'delay') await new Promise(resolve => window.releaseRequest = resolve);
        if (settings.audio && r.mode === 'noAudioTrack') {
          for (const track of media.getAudioTracks()) { media.removeTrack(track); track.stop(); }
        }
        return media;
      };
      const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
      URL.createObjectURL = blob => { const url = create(blob); r.urls.push(url); return url; };
      URL.revokeObjectURL = url => { r.revoked.push(url); revoke(url); };
      Object.defineProperty(navigator, 'wakeLock', { configurable:true, value: {request: async () => {
        if (r.delayLock) await new Promise(resolve => window.releaseLockRequest = resolve);
        const lock = new EventTarget();
        lock.released = false;
        lock.release = async () => { lock.released = true; lock.dispatchEvent(new Event('release')); };
        r.locks.push(lock);
        return lock;
      } } });
      window.SpeechRecognition = class {
        start() { r.speech.push('start'); this.onstart?.(); }
        abort() { r.speech.push('abort'); this.onerror?.({error:'aborted'}); this.onend?.(); }
      };
      Object.defineProperty(navigator, 'canShare', { configurable:true, value: () => r.mode !== 'noShare' });
      Object.defineProperty(navigator, 'share', { configurable:true, value: ({files}) => {
        r.sharing.push({type: files[0].type, name: files[0].name, active: navigator.userActivation?.isActive});
        if (r.mode === 'abortShare') return Promise.reject(new DOMException('cancel','AbortError'));
        if (r.mode === 'failShare') return Promise.reject(new DOMException('fail','NotAllowedError'));
        return Promise.resolve();
      } });
      const Native = MediaRecorder;
      {
        const proxy = new Proxy(Native, {
          construct(target, args) {
            if (variant === 'failCodec' && args[1]?.mimeType?.includes('mp4')) throw new DOMException('codec down','NotSupportedError');
            const recorder = Reflect.construct(target,args);
            r.events ||= [];
            r.events.push('new: ' + args[1]?.mimeType);
            for (const type of ['error','start','stop','pause','resume','dataavailable']) {
              recorder.addEventListener(type, (event) => {
                if (type !== 'dataavailable') r.events.push(type + ': ' + recorder.state + ' ' + (event.error?.message || ''));
              });
            }
            return recorder;
          },
          get(target, key) {
            if (key === 'isTypeSupported' && variant === 'webm') return mime => !mime.includes('mp4') && target.isTypeSupported(mime);
            return typeof target[key] === 'function' && key === 'isTypeSupported' ? target[key].bind(target) : target[key];
          }
        });
        window.MediaRecorder = proxy;
      }
    }, {variant,useWebKit});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(address);
    return {page,context,errors};
  }
  const wait = (page, expression, timeout = 12000) => page.waitForFunction(expression,null,{timeout});
  const press = (p,id) => p.locator('#' + id).click();
  const visible = (p,id,show=true) => p.locator('#'+id).waitFor({state:show?'visible':'hidden'});
  const preview = p => wait(p, () => document.querySelector('#previewVideo').readyState >= 2);
  const diagnose = p => p.evaluate(() => ({ events:r.events, speech:r.speech, tracks:r.tracks.map(t=>[t.kind,t.readyState,t.muted]), toast:document.querySelector('#toast').textContent, notice:document.querySelector('#reviewNotice').textContent, rec:document.querySelector('#recTimerPill').className }));
  const rec = async p => {
    try { await wait(p, () => document.querySelector('#recTimerPill').classList.contains('visible')); }
    catch (error) { console.log(await diagnose(p)); throw error; }
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function probe(path) {
    return JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration,format_name:stream=codec_name,codec_type,width,height','-of','json',path],{encoding:'utf8'}));
  }
  function audioIsNonSilent(file) {
    const result = require('child_process').spawnSync('ffmpeg',['-hide_banner','-i',file,'-map','0:a','-af','volumedetect','-f','null','-'],{encoding:'utf8'});
    const peak = Number(result.stderr.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1]);
    assert.ok(peak > -55, result.stderr);
  }

  async function recordCase(variant, expected, long = false) {
    const {page:p,context,errors} = await pageSetup(variant);
    await preview(p);
    assert.deepEqual(await p.evaluate(() => r.calls), [false]);
    await press(p,'btnSettings');
    await press(p,'switchVoice');
    await press(p,'btnCloseSettings');
    await press(p,'btnRehearse');
    assert.deepEqual(await p.evaluate(() => r.speech), ['start']);
    await press(p,'btnShutter');
    await rec(p);
    assert.deepEqual(await p.evaluate(() => r.speech), ['start','abort']);
    assert.deepEqual(await p.evaluate(() => r.calls), [false,true]);
    const begin = Date.now();
    await sleep(long ? 14500 : 850);
    await press(p,'btnLeftAction');
    try { await wait(p, () => document.querySelector('#recTimerPill').classList.contains('paused')); }
    catch (error) { console.log(await diagnose(p)); throw error; }
    const pausedAt = Date.now();
    await sleep(long ? 2200 : 1150);
    await press(p,'btnLeftAction');
    const resumed = Date.now();
    await sleep(long ? 15100 : 450);
    const liveMs = pausedAt - begin + Date.now() - resumed;
    await press(p,'btnShutter');
    await visible(p,'reviewOverlay');
    await wait(p, () => document.querySelector('#reviewVideo').readyState >= 1);
    await p.locator('#reviewVideo').evaluate(async video => {
      await video.play();
      video.currentTime = video.duration / 2;
      video.pause();
    });
    assert.ok(await p.evaluate(() => r.tracks.every(track => track.readyState === 'ended') && r.locks.every(lock => lock.released)));
    assert.ok(await p.evaluate(() => Number.isFinite(document.querySelector('#reviewVideo').duration)));
    await p.evaluate(() => r.mode='abortShare');
    await press(p,'btnSaveAlbum');
    assert.match(await p.locator('#btnDownload').getAttribute('download'), new RegExp('[.]'+expected+'$'));
    const share = await p.evaluate(() => r.sharing.at(-1));
    assert.equal(share.type,'video/'+expected);
    if (share.active !== undefined) assert.equal(share.active,true);
    await p.evaluate(() => r.mode='failShare');
    await press(p,'btnSaveAlbum');
    assert.match(await p.locator('#toast').textContent(), /下载文件/);
    await p.evaluate(() => r.mode='noShare');
    const [download] = await Promise.all([p.waitForEvent('download'),press(p,'btnSaveAlbum')]);
    const file = variant + (long ? '-30s' : '') + (useWebKit ? '-webkit' : '') + '.' +expected;
    await download.saveAs(file);
    const meta = probe(file);
    assert.ok(meta.format.format_name.includes(expected));
    assert.ok(meta.streams.some(track => track.codec_type === 'video'));
    assert.ok(meta.streams.some(track => track.codec_type === 'audio'));
    assert.ok(Math.abs(Number(meta.format.duration) - liveMs / 1000) < (long ? .75 : .6), JSON.stringify({meta,liveMs}));
    audioIsNonSilent(file);
    await press(p,'btnRetake');
    await preview(p);
    assert.ok(await p.evaluate(() => r.revoked.length === 1 && r.calls.at(-1) === false && r.tracks.filter(t=>t.readyState==='live').map(t=>t.kind).join() === 'video'));
    await p.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    assert.ok(await p.evaluate(() => r.tracks.every(track => track.readyState === 'ended')));
    await p.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    await preview(p);
    assert.deepEqual(errors, []);
    console.log('record', variant, 'active measured', liveMs, 'file', file, JSON.stringify(meta));
    await context.close();
  }

  async function testUi() {
    const {page:p,context,errors} = await pageSetup('ui',320,640);
    await preview(p);
    await press(p,'btnCloseWechat');
    assert.ok(!/has-wechat-banner/.test(await p.locator('body').getAttribute('class') || ''));
    await press(p,'btnTopScript');
    await press(p,'btnNewScript');
    await p.locator('#scriptTitleInput').fill('<img src=x onerror=alert(9)>');
    await p.locator('#scriptBodyInput').fill('测试极长稿\n' + '中国abcdef'.repeat(1400));
    assert.match(await p.locator('#editorCharStat').textContent(), /112/);
    assert.equal(await p.locator('.script-card img').count(),0);
    await press(p,'btnCloseScripts');
    await press(p,'btnLeftAction');
    await p.locator('.script-card-select').nth(1).click();
    p.once('dialog', dialog => dialog.dismiss());
    await p.locator('.script-card.active .script-del-btn').click();
    assert.equal(await p.locator('.script-card').count(),3);
    p.once('dialog', dialog => dialog.accept());
    await p.locator('.script-card.active .script-del-btn').click();
    assert.equal(await p.locator('.script-card').count(),2);
    await p.keyboard.press('Escape');
    await press(p,'btnSpeedDown');
    assert.equal(await p.locator('#speedValue').textContent(),'34');
    await press(p,'btnSpeedUp');
    for (const speed of [24,38,62]) {
      await p.locator('[data-speed="'+speed+'"]').click();
      assert.equal(await p.locator('#speedValue').textContent(),String(speed));
    }
    await press(p,'btnSettings');
    for (const [id, val] of [['sliderSpeed','110'],['sliderFontSize','48'],['sliderOpacity','0'],['sliderLeadDelay','0']]) {
      await p.locator('#'+id).fill(val);
      assert.equal(await p.locator('#'+id).inputValue(), val);
    }
    await press(p,'btnResetWindow');
    await press(p,'btnCloseSettings');
    assert.ok(await p.locator('#btnSpeedUp').isDisabled());
    await p.locator('#tpDragBar').focus();
    const offset = await p.locator('#tpWindow').boundingBox();
    await p.keyboard.press('ArrowDown');
    assert.ok((await p.locator('#tpWindow').boundingBox()).y > offset.y);
    await press(p,'tpResetBtn');
    if (!useWebKit) {
      const cdp = await context.newCDPSession(p);
      const touchDrag = async (locator, dx, dy) => {
        const box = await locator.boundingBox();
        const x = Math.round(box.x+box.width/2), y = Math.round(box.y+box.height/2);
        for (const [type,points] of [
          ['touchStart',[{x,y}]],
          ['touchMove',[{x:x+dx,y:y+dy}]],
          ['touchEnd',[]]
        ]) await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points});
      };
      const before = await p.locator('#tpWindow').boundingBox();
      await touchDrag(p.locator('#tpDragBar'),0,35);
      const after = await p.locator('#tpWindow').boundingBox();
      assert.ok(after.y > before.y);
      await touchDrag(p.locator('#tpResizeHandle'),0,38);
      assert.ok((await p.locator('#tpWindow').boundingBox()).height > after.height);
      await touchDrag(p.locator('#tpViewport'),0,-55);
      assert.ok(await p.locator('#tpTrack').evaluate(e=>new DOMMatrix(getComputedStyle(e).transform).m42 < 0));
      await press(p,'btnSettings');
      await p.locator('#sliderSpeed').scrollIntoViewIfNeeded();
      const sheetScroll = await p.locator('#settingsSheet .sheet-body').evaluate(e=>e.scrollTop);
      const beforeSpeed = await p.locator('#sliderSpeed').inputValue();
      await touchDrag(p.locator('#sliderSpeed'),-35,-55);
      assert.equal(await p.locator('#settingsSheet .sheet-body').evaluate(e=>e.scrollTop),sheetScroll);
      assert.notEqual(await p.locator('#sliderSpeed').inputValue(), beforeSpeed);
      assert.equal(await p.evaluate(()=>scrollY),0);
      await p.locator('#sheetBackdrop').click({position:{x:2,y:2}});
    }
    await p.setViewportSize({width:640,height:320});
    await wait(p, () => {
      const end = document.querySelector('#tpWindow').getBoundingClientRect().bottom;
      const dock = document.querySelector('#bottomDock').getBoundingClientRect().top;
      return end <= dock;
    });
    await p.setViewportSize({width:320,height:640});
    await press(p,'btnRehearse');
    await press(p,'btnRehearse');
    await p.evaluate(() => r.delayLock=true);
    await press(p,'btnShutter');
    await visible(p,'countdownOverlay');
    await press(p,'countdownCancel');
    await p.evaluate(() => { r.delayLock=false; window.releaseLockRequest?.(); });
    await preview(p);
    assert.ok(await p.evaluate(() => r.locks.every(lock=>lock.released)));
    await p.evaluate(() => r.mode = 'denyAudio');
    await press(p,'btnShutter');
    await visible(p,'cameraFallback');
    await press(p,'btnPreviewNoCam');
    assert.ok(await p.evaluate(()=>document.querySelector('#previewVideo').srcObject===null));
    await p.evaluate(() => r.mode = 'denyAll');
    await press(p,'btnShutter');
    await visible(p,'cameraFallback');
    await p.evaluate(() => r.mode = 'ok');
    await press(p,'btnRetryCamera');
    await preview(p);
    await p.evaluate(() => r.mode='delay');
    await press(p,'btnShutter');
    await wait(p, () => typeof window.releaseRequest === 'function');
    await press(p,'countdownCancel');
    await p.evaluate(() => { r.mode='ok'; window.releaseRequest(); });
    await preview(p);
    assert.ok(await p.evaluate(() => r.tracks.filter(t=>t.readyState==='live').every(t=>t.kind==='video')));
    assert.deepEqual(errors, []);
    console.log('ui controls, 320px touch/landscape, permissions, cancel race and Wake Lock: PASS');
    await context.close();
  }

  async function interruption() {
    const {page:p,context,errors} = await pageSetup('brokenStorage');
    await preview(p);
    assert.equal(await p.locator('#speedValue').textContent(),'38');
    assert.equal(await p.locator('#hudScriptTitle').textContent(),'未命名稿件');
    await p.evaluate(()=>r.mode='noAudioTrack');
    await press(p,'btnShutter');
    await visible(p,'cameraFallback');
    await p.evaluate(()=>r.mode='ok');
    await press(p,'btnRetryCamera');
    await preview(p);
    await press(p,'btnShutter');
    await rec(p);
    await sleep(550);
    await p.evaluate(()=>r.tracks.findLast(t=>t.kind==='audio').dispatchEvent(new Event('mute')));
    await visible(p,'reviewOverlay');
    assert.match(await p.locator('#reviewNotice').textContent(), /中断/);
    assert.ok(await p.evaluate(()=>r.tracks.every(t=>t.readyState==='ended')));
    await press(p,'btnRetake');
    await preview(p);
    await press(p,'btnShutter');
    await rec(p);
    await sleep(250);
    await p.evaluate(() => {
      Object.defineProperty(document,'hidden',{configurable:true,value:true});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await visible(p,'reviewOverlay');
    assert.match(await p.locator('#reviewNotice').textContent(), /后台/);
    assert.deepEqual(errors, []);
    console.log('corrupt storage, missing audio track, interrupted microphone, background recording: PASS');
    await context.close();
  }

  async function webKitUi() {
    const {page:p,context,errors} = await pageSetup('ui',320,640);
    await visible(p,'cameraFallback');
    await press(p,'btnRetryCamera');
    await visible(p,'cameraFallback');
    await press(p,'btnPreviewNoCam');
    await press(p,'btnCloseWechat');
    await press(p,'btnTopScript');
    await press(p,'btnNewScript');
    await p.locator('#scriptBodyInput').fill('用 WebKit 验证无相机提词模式。');
    await press(p,'btnCloseScripts');
    await press(p,'btnSettings');
    await p.locator('#sliderSpeed').focus();
    await p.keyboard.press('End');
    assert.equal(await p.locator('#sliderSpeed').inputValue(),'110');
    await press(p,'btnCloseSettings');
    await press(p,'btnRehearse');
    await press(p,'btnRehearse');
    await press(p,'btnShutter');
    assert.match(await p.locator('#toast').textContent(), /不支持网页录像/);
    assert.deepEqual(errors, []);
    console.log('Windows WebKit: no-camera fallback, settings, script editing and rehearsal PASS');
    await context.close();
  }

  try {
    const cases = { ui:testUi, mp4:()=>recordCase('mp4','mp4'), webm:()=>recordCase('webm','webm',!process.argv.includes('--quick')), failCodec:()=>recordCase('failCodec','webm'), interruption };
    const only = process.argv.find(a => a.startsWith('--case='))?.slice(7);
    if (useWebKit) {
      await webKitUi();
      return;
    }
    const keys = only ? [only] : Object.keys(cases);
    const results = [];
    for (const key of keys) results.push(...await Promise.allSettled([cases[key]()]));
    for (const result of results) if (result.status==='rejected') console.error(result.reason);
    if (results.some(result=>result.status==='rejected')) process.exitCode=1;
  } finally {
    await browser.close();
    server.close();
  }
}
test().catch(error => { console.error(error); server.close(); process.exitCode=1; });

