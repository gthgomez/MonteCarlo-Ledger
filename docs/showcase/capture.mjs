// Capture the real local UI. No app source, backend responses or screenshots are mocked.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const origin = new URL(process.env.SHOWCASE_URL || 'http://127.0.0.1:4312');
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('Use a loopback local server; production capture is intentionally unsupported.');
const out = join(here, 'media');
await mkdir(out, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'readme-showcase-'));
const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox']});
const context = await browser.newContext({viewport: {width: 1280, height: 900}, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: 'reduce', recordVideo: {dir: temp, size: {width: 1280, height: 900}}});
const blockedHosts = new Set();
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return route.continue();
  blockedHosts.add(url.hostname);
  return route.abort('blockedbyclient');
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
await page.clock.setFixedTime(new Date('2026-10-30T12:00:00Z'));
const screenshots = [];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const pause = ms => page.waitForTimeout(ms);
const shot = async (name, description) => {
  await pause(700);
  await page.screenshot({path: join(out, `${name}.jpg`), type: 'jpeg', quality: 88});
  screenshots.push({file: `${name}.jpg`, description});
  await pause(1800);
};
const recordingStarted = Date.now();
let trimSeconds;
try {
  await page.goto(new URL('/', origin).href, {waitUntil: 'networkidle', timeout: 90000});
  trimSeconds = (Date.now() - recordingStarted) / 1000;
  // SCENARIO

  await page.getByText('Safe to Spend (P10)',{exact:true}).waitFor();
  await shot('01-forecast', 'Synthetic household dashboard: computed safe-to-spend and cash-flow timeline.');
  await page.getByRole('heading',{name:/Decision/i}).first().evaluate(el=>el.scrollIntoView({block:'start'}));
  await page.locator('input[type=range]').first().fill('650');
  await shot('02-decisions', 'Decision Studio: local hypothetical-purchase scenario and comparison.');
  await page.getByRole('button',{name:'Late Paycheck',exact:true}).click();
  await shot('03-income-delay', 'Delayed-income scenario; client-side Contract 2.0 calculations on sample data.');
  await page.getByRole('heading',{name:'Ledger Persistence & Obligations'}).evaluate(el=>el.scrollIntoView({block:'start'}));
  await page.getByPlaceholder('e.g. Electric Bill, Rent, Netflix').fill('Demo Bike Maintenance');
  await page.getByRole('button',{name:'Add Recurring Bill'}).click();
  await page.getByText('Demo Bike Maintenance',{exact:true}).waitFor();
  await shot('04-sample-ledger', 'Added Demo Bike Maintenance to the synthetic household recurring bills.');

  await pause(1200);
  const video = page.video();
  await context.close();
  const raw = await video.path();
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const caption = 'LOCAL UI - SYNTHETIC HOUSEHOLD - CLIENT-SIDE SIMULATION';
  const filter = `scale=960:-2,fps=15,drawbox=x=0:y=ih-36:w=iw:h=36:color=black@0.9:t=fill,drawtext=text='${caption}':fontcolor=white:fontsize=15:x=14:y=h-25`;
  execFileSync(ffmpeg, ['-y','-ss',String(trimSeconds),'-i',raw,'-an','-vf',filter,'-c:v','libx264','-preset','veryfast','-crf','28','-pix_fmt','yuv420p','-movflags','+faststart',join(out,'workflow.mp4')], {stdio:'pipe'});
  const duration = Number(execFileSync('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',join(out,'workflow.mp4')], {encoding:'utf8'}).trim());
  const gifSpeed = Math.max(1, duration / 16);
  execFileSync(ffmpeg, ['-y','-i',join(out,'workflow.mp4'),'-filter_complex',`[0:v]setpts=PTS/${gifSpeed},fps=4,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,'-loop','0',join(out,'preview.gif')],{stdio:'pipe'});
  const files = {};
  for (const name of [...screenshots.map(s => s.file), 'workflow.mp4','preview.gif']) {
    const content = await readFile(join(out,name));
    files[name] = {bytes: content.length, sha256: createHash('sha256').update(content).digest('hex')};
  }
  const revision = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  await writeFile(join(here,'capture.json'), JSON.stringify({sourceRevision:revision,capturedAt:new Date().toISOString(),dateInBrowser:'2026-10-30T12:00:00Z',browser:browser.version(),viewport:{width:1280,height:900},origin:origin.origin,externalRequestsBlocked:true,blockedHosts:[...blockedHosts],sampleData:'Shipped SAMPLE_LEDGER_STATE only, clean browser storage; synthetic household figures. Date fixed to 2026-10-30; no sync/vault/real account accessed.',workflow:'Inspect forecast; test a hypothetical purchase and delayed income; add a synthetic recurring bill.',videoSeconds:duration,gifPlaybackSpeed:gifSpeed,pageErrors:errors,screenshots,files},null,2)+'\n');
  if (errors.length) throw new Error(`UI emitted ${errors.length} page error(s); inspect capture.json before publishing.`);
  console.log(`Captured ${screenshots.length} screenshots and ${duration.toFixed(1)}s real UI video at ${revision}`);
} finally {
  await browser.close();
  await rm(temp,{recursive:true,force:true});
}
