/**
 * 全国版交互冒烟测试（Playwright + 本机 Chrome）
 *
 * 覆盖：全国 → 省 → 市 → 区县 下钻、搜索、类别筛选、详情、地图标记、
 *       面包屑返回、刷新还原、空状态、移动端布局。
 *
 * 用法：先 npm run dev，再 node tools/smoke-test.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const SHOT_DIR = 'tmp-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitTiles(page) {
  await page
    .waitForFunction(() => document.querySelectorAll('.leaflet-tile-loaded').length > 4, null, {
      timeout: 8000,
    })
    .catch(() => {});
  await page.waitForTimeout(250);
}

async function waitReady(page) {
  await page.waitForSelector('.map-overlay', { state: 'detached', timeout: 30000 }).catch(() => {});
  await waitTiles(page);
  await page.waitForTimeout(500);
}

/**
 * 点击地图上某个 adcode 对应的多边形。
 * 用项目自己的 GeoJSON 做点面判定来挑落点（不依赖 Leaflet 私有方法），
 * 跳过被聚合气泡遮挡的位置，并校验 hash 是否真的跳过去了。
 */
async function clickRegion(page, adcode, parentOverride = null) {
  const parent = parentOverride ?? (await page.evaluate(() => {
    const segs = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
    return segs.length ? Number(segs[segs.length - 1]) : 100000;
  }));

  const candidates = await page.evaluate(
    async ([code, parentCode]) => {
      const geo = await fetch(`/geo/g/${parentCode}.json`).then((r) => r.json());
      const feature = geo.features.find((f) => f.properties.adcode === code);
      if (!feature) return [];

      const polys =
        feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;

      const inRing = (lng, lat, ring) => {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const xi = ring[i][0];
          const yi = ring[i][1];
          const xj = ring[j][0];
          const yj = ring[j][1];
          if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      };
      const contains = (lng, lat) =>
        polys.some((rings) => inRing(lng, lat, rings[0]) && !rings.slice(1).some((h) => inRing(lng, lat, h)));

      let minLng = Infinity;
      let minLat = Infinity;
      let maxLng = -Infinity;
      let maxLat = -Infinity;
      for (const rings of polys) {
        for (const [lng, lat] of rings[0]) {
          minLng = Math.min(minLng, lng);
          maxLng = Math.max(maxLng, lng);
          minLat = Math.min(minLat, lat);
          maxLat = Math.max(maxLat, lat);
        }
      }

      const map = window.__scenicMap;
      const out = [];
      const STEPS = 16;
      for (let i = 1; i < STEPS; i++) {
        for (let j = 1; j < STEPS; j++) {
          const lng = minLng + ((maxLng - minLng) * i) / STEPS;
          const lat = minLat + ((maxLat - minLat) * j) / STEPS;
          if (!contains(lng, lat)) continue;
          const p = map.latLngToContainerPoint([lat, lng]);
          out.push({ x: p.x, y: p.y });
        }
      }
      return out;
    },
    [adcode, parent],
  );

  if (!candidates.length) throw new Error(`地图上找不到 adcode=${adcode} 的可点区域`);
  const box = await page.locator('.map-canvas').boundingBox();
  const want = String(adcode);
  const before = await page.evaluate(() => location.hash || '#/');

  for (const point of candidates) {
    if (point.x < 6 || point.y < 6 || point.x > box.width - 6 || point.y > box.height - 6) continue;
    const blocked = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return Boolean(el && el.closest('.marker-holder'));
      },
      [box.x + point.x, box.y + point.y],
    );
    if (blocked) continue;
    await page.mouse.click(box.x + point.x, box.y + point.y);
    await page.waitForTimeout(900);
    const hash = await page.evaluate(() => location.hash);
    if (hash.includes(want)) {
      await waitReady(page);
      return;
    }
    // 偶尔会点到邻区：回到原位置后换下一个候选点
    await page.goto(`${BASE}/${before}`, { waitUntil: 'networkidle' });
    await waitReady(page);
  }
  throw new Error(`点击 adcode=${adcode} 未能进入该区域`);
}

/** 优先用本机 Chrome（渲染与真实用户一致），找不到就退回 Playwright 自带内核 */
async function launchBrowser() {
  const candidates = [
    { channel: 'chrome' },
    { executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
    {},
  ];
  for (const options of candidates) {
    try {
      return await chromium.launch(options);
    } catch {
      // 换下一个候选
    }
  }
  throw new Error('没有可用的浏览器内核，请运行 npx playwright install chromium');
}

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

console.log('\n【1】全国首页');
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await waitReady(page);
check('首页展示全国地图', (await page.locator('.breadcrumb__current').innerText()) === '中国');
check('地图渲染 34 个省级要素', (await page.evaluate(() => window.__scenicGeoLayer.getLayers().length)) === 34);
check('省份导航列出 34 项', (await page.locator('.region-grid__item').count()) === 34);
const zjCount = Number(
  (await page.locator('.region-grid__item', { hasText: '浙江省' }).locator('.region-grid__count').innerText()).trim(),
);
check('浙江省显示景点数量', zjCount > 50, `实际 ${zjCount}`);
await page.screenshot({ path: `${SHOT_DIR}/01-china.png` });

console.log('\n【2】进入浙江省');
await page.locator('.region-grid__item', { hasText: '浙江省' }).click();
await waitReady(page);
check('面包屑为浙江省', (await page.locator('.breadcrumb__current').innerText()) === '浙江省');
check('URL 使用 adcode', page.url().endsWith('#/330000'), page.url());
check('地图渲染 11 个地级要素', (await page.evaluate(() => window.__scenicGeoLayer.getLayers().length)) === 11);
await page.waitForSelector('.poi-card', { timeout: 15000 });
const zjCards = await page.locator('.poi-card').count();
check('省级列表分批渲染首屏', zjCards >= 40 && zjCards <= 120, `实际 ${zjCards}`);
const progressText = (await page.locator('.panel-list__progress').innerText()).replace(/\s+/g, ' ');
check('底部提示已显示条数与总数', progressText.includes(`已显示 ${zjCards} / ${zjCount}`), progressText);
const zjNodes = await page.evaluate(() => document.querySelectorAll('*').length);
check('上千景点不全量铺开 DOM', zjNodes < 8000, `节点 ${zjNodes} 个`);
await page.locator('.panel-list__more button').click();
await page.waitForTimeout(400);
check('点「加载更多」追加下一批', (await page.locator('.poi-card').count()) > zjCards);
await page.evaluate(() => {
  document.querySelector('.panel-list').scrollTop = 0;
});
await page.screenshot({ path: `${SHOT_DIR}/02-zhejiang.png` });

console.log('\n【3】点击地图进入杭州市');
await clickRegion(page, 330100);
check('面包屑为杭州市', (await page.locator('.breadcrumb__current').innerText()) === '杭州市');
check('URL 为 #/330000/330100', page.url().endsWith('#/330000/330100'), page.url());
check('地图渲染 13 个区县要素', (await page.evaluate(() => window.__scenicGeoLayer.getLayers().length)) === 13);
await page.screenshot({ path: `${SHOT_DIR}/03-hangzhou.png` });

console.log('\n【4】点击地图进入西湖区');
await clickRegion(page, 330106);
check('面包屑为西湖区', (await page.locator('.breadcrumb__current').innerText()) === '西湖区');
check('区县视图显示编号标记', (await page.locator('.poi-marker').count()) > 5);
const xihuCards = await page.locator('.poi-card').count();
check('西湖区景点列表非空', xihuCards > 5, `实际 ${xihuCards}`);
const names = await page.locator('.poi-card__name').allInnerTexts();
check('包含人工核对的西湖', names.includes('西湖'));
check('包含灵隐寺', names.includes('灵隐寺'));
check('包含西溪国家湿地公园', names.includes('西溪国家湿地公园'));
await page.screenshot({ path: `${SHOT_DIR}/04-xihu.png` });

console.log('\n【5】搜索与筛选');
await page.fill('.searchbox__input', '灵隐寺');
await page.waitForTimeout(400);
const lyCards = await page.locator('.poi-card__name').allInnerTexts();
check('搜索「灵隐寺」命中 1 条', lyCards.length === 1, `实际 ${lyCards.length}: ${lyCards.join(' / ')}`);
check('搜索后地图标记同步为 1 个', (await page.locator('.poi-marker').count()) === 1);
await page.fill('.searchbox__input', '灵隐');
await page.waitForTimeout(400);
const lingyin = await page.locator('.poi-card').count();
check('搜索「灵隐」命中含名称与地址匹配', lingyin >= 1 && lingyin <= 3, `命中 ${lingyin}`);
await page.screenshot({ path: `${SHOT_DIR}/05-search.png` });
await page.locator('.searchbox__clear').click();
await page.waitForTimeout(300);
check('清除搜索后恢复列表', (await page.locator('.poi-card').count()) === xihuCards);

await page.locator('.chip', { hasText: '博物馆' }).click();
await page.waitForTimeout(400);
const museumCards = await page.locator('.poi-card').count();
check('筛选博物馆后数量减少', museumCards > 0 && museumCards < xihuCards, `${museumCards}/${xihuCards}`);
check('筛选后地图标记同步', (await page.locator('.poi-marker').count()) === museumCards);
await page.locator('.chip', { hasText: '博物馆' }).click();
await page.waitForTimeout(300);

console.log('\n【5b】等级筛选');
const levelChips = await page.locator('.chips--level .chip').allInnerTexts();
check(
  '等级筛选提供 5A / 4A',
  levelChips.some((t) => t.startsWith('5A')) && levelChips.some((t) => t.startsWith('4A')),
  levelChips.join(' / ').replace(/\n/g, ' '),
);
await page.locator('.chips--level .chip', { hasText: '5A' }).click();
await page.waitForTimeout(450);
const fiveACards = await page.locator('.poi-card').count();
check('筛选 5A 后数量减少', fiveACards > 0 && fiveACards < xihuCards, `${fiveACards}/${xihuCards}`);
check(
  '5A 结果全部带 5A 角标',
  (await page.locator('.poi-card .level-badge', { hasText: '5A' }).count()) === fiveACards,
);
check('5A 筛选后地图标记同步', (await page.locator('.poi-marker').count()) === fiveACards);
await page.screenshot({ path: `${SHOT_DIR}/05b-level-5a.png` });
await page.locator('.chips--level .chip', { hasText: '4A' }).click();
await page.waitForTimeout(450);
const fourACards = await page.locator('.poi-card').count();
check('切到 4A 后换成另一批景区', fourACards > 0 && fourACards !== fiveACards, `${fourACards}`);
check(
  '4A 结果全部带 4A 角标',
  (await page.locator('.poi-card .level-badge', { hasText: '4A' }).count()) === fourACards,
);
await page.locator('.chips--level .chip', { hasText: '不限' }).click();
await page.waitForTimeout(450);
check('等级恢复不限后列表还原', (await page.locator('.poi-card').count()) === xihuCards);

console.log('\n【6】景点详情');
await page.locator('.poi-card__name', { hasText: /^西湖$/ }).click();
await page.waitForTimeout(500);
check('抽屉打开', (await page.locator('.drawer').count()) === 1);
check('详情标题为西湖', (await page.locator('.drawer__title').innerText()) === '西湖');
const drawerText = await page.locator('.drawer').innerText();
check('详情含所属省份', drawerText.includes('浙江省'));
check('详情含所属城市', drawerText.includes('杭州市'));
check('详情含所属区县', drawerText.includes('西湖区'));
check('详情标注数据来源', drawerText.includes('人工核对'));
check('URL 带上 poi 参数', page.url().includes('poi='));
await page.screenshot({ path: `${SHOT_DIR}/06-detail.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('Esc 关闭详情', (await page.locator('.drawer').count()) === 0);

console.log('\n【6b】百科介绍 / 门票 / 游玩攻略');
// 鼓浪屿：5A，既有百科摘要与信息卡，也有 AI 攻略，用来验证详情抽屉的三块新内容
await page.goto(`${BASE}/#/350000/350200/350203?poi=al-350203-65663`, { waitUntil: 'networkidle' });
await page.waitForSelector('.drawer', { timeout: 20000 });
await page.waitForTimeout(600);
const richText = await page.locator('.drawer').innerText();
check('详情含百科介绍正文', richText.includes('鼓浪屿') && richText.length > 300);
check('介绍标注出处', (await page.locator('.drawer__cite').count()) >= 1);
const infoGrids = await page.locator('.info-grid').count();
check('展示门票与开放时间', infoGrids >= 1, `info-grid=${infoGrids}`);
const guideCount = await page.locator('.drawer__section--guide').count();
check('展示游玩攻略区块', guideCount === 1);
if (guideCount) {
  check('攻略有小节标题', (await page.locator('.drawer__section--guide .guide__block').count()) >= 1);
}
await page.screenshot({ path: `${SHOT_DIR}/06b-encyclopedia-guide.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// 后面几节都在西湖区做，这里把状态切回去
await page.goto(`${BASE}/#/330000/330100/330106`, { waitUntil: 'networkidle' });
await waitReady(page);

console.log('\n【6c】列表定位：跨层级跳到景点所属区县');
await page.goto(`${BASE}/#/330000`, { waitUntil: 'networkidle' });
await waitReady(page);
await page.fill('.searchbox__input', '灵隐');
await page.waitForTimeout(500);
await page.locator('.poi-card button[title="在地图上定位"]').first().click();
await page.waitForTimeout(2600);
check('定位后面包屑进入所属区县', (await page.locator('.breadcrumb__current').innerText()) === '西湖区');
check(
  '定位后 URL 变成三级 adcode',
  /#\/330000\/330100\/330106/.test(await page.evaluate(() => location.hash)),
);
check('定位后区县显示编号标记', (await page.locator('.poi-marker').count()) > 0);
check('定位后地图放大到街道级', (await page.evaluate(() => window.__scenicMap.getZoom())) > 12);
await page.screenshot({ path: `${SHOT_DIR}/06c-locate-cross-level.png` });

await page.locator('.poi-marker__dot').first().click({ force: true });
await page.waitForTimeout(600);
check('点击地图标记打开详情', (await page.locator('.drawer').count()) === 1);
await page.screenshot({ path: `${SHOT_DIR}/07-marker.png` });
await page.locator('.drawer__foot .btn--ghost').click();
await page.waitForTimeout(300);

console.log('\n【7b】底图清晰度随缩放变化');
const basemapVar = (name) =>
  page.evaluate(
    (n) => Number(document.querySelector('.leaflet-container')?.style.getPropertyValue(n) || 0),
    name,
  );
await page.evaluate(() => window.__scenicMap.setZoom(8));
await page.waitForTimeout(700);
const opFar = await basemapVar('--basemap-opacity');
const grayFar = await basemapVar('--basemap-gray');
await page.evaluate(() => window.__scenicMap.setZoom(13));
await page.waitForTimeout(800);
const opNear = await basemapVar('--basemap-opacity');
const grayNear = await basemapVar('--basemap-gray');
check('放大后底图变清晰（街道可见）', opNear - opFar > 0.4, `${opFar} → ${opNear}`);
check('放大后底图去饱和减弱', grayNear < grayFar - 0.3, `${grayFar} → ${grayNear}`);
await page.screenshot({ path: `${SHOT_DIR}/07b-zoom-detail.png` });

console.log('\n【8】面包屑与返回');
await page.locator('.breadcrumb__link', { hasText: '杭州市' }).click();
await waitReady(page);
check('面包屑返回杭州市', (await page.locator('.breadcrumb__current').innerText()) === '杭州市');
check('返回到市级后仍显示区县边界', (await page.evaluate(() => window.__scenicGeoLayer.getLayers().length)) === 13);
await page.screenshot({ path: `${SHOT_DIR}/08-back.png` });
await page.locator('.back-btn').click();
await waitReady(page);
check('返回按钮回到浙江省', (await page.locator('.breadcrumb__current').innerText()) === '浙江省');

console.log('\n【9】浏览器前进后退');
await page.goBack();
await page.waitForTimeout(1200);
check('浏览器后退回到杭州市', (await page.locator('.breadcrumb__current').innerText()) === '杭州市');
await page.goForward();
await page.waitForTimeout(1200);
check('浏览器前进回到浙江省', (await page.locator('.breadcrumb__current').innerText()) === '浙江省');

console.log('\n【8b】同层切换区县');
await page.goto(`${BASE}/#/330000/330100/330106`, { waitUntil: 'networkidle' });
await waitReady(page);
await clickRegion(page, 330102, 330100);
check('在区县视图点击邻区可切换', (await page.locator('.breadcrumb__current').innerText()) === '上城区');
await page.screenshot({ path: `${SHOT_DIR}/08b-sibling.png` });

console.log('\n【10】刷新还原');
await page.goto(`${BASE}/#/330000/330100/330106`, { waitUntil: 'networkidle' });
await waitReady(page);
check('深链接直接打开西湖区', (await page.locator('.breadcrumb__current').innerText()) === '西湖区');
check('深链接景点列表正常', (await page.locator('.poi-card').count()) > 5);
await page.reload({ waitUntil: 'networkidle' });
await waitReady(page);
check('刷新后状态保持', (await page.locator('.breadcrumb__current').innerText()) === '西湖区');

console.log('\n【11】空区县与无下级省份');
const emptyDistrict = await page.evaluate(async () => {
  const [index, summary] = await Promise.all([
    fetch('/geo/index.json').then((r) => r.json()),
    fetch('/data/attractions/summary.json').then((r) => r.json()),
  ]);
  const kids = index.nodes.filter((n) => n[2] === 330100);
  const hit = kids.find((n) => !summary.districts?.[n[0]]);
  return hit ? { adcode: hit[0], name: hit[1] } : null;
});
if (emptyDistrict) {
  await page.goto(`${BASE}/#/330000/330100/${emptyDistrict.adcode}`, { waitUntil: 'networkidle' });
  await waitReady(page);
  check(`空区县（${emptyDistrict.name}）显示空状态`, (await page.locator('.empty__title').innerText()).includes('暂未收录'));
} else {
  check('空区县用例（杭州全部区县都有数据，跳过）', true);
}
await page.screenshot({ path: `${SHOT_DIR}/09-empty.png` });

await page.goto(`${BASE}/#/710000`, { waitUntil: 'networkidle' });
await waitReady(page);
check('无下级省份（台湾省）可进入', (await page.locator('.breadcrumb__current').innerText()) === '台湾省');
check('无下级省份显示空状态', (await page.locator('.empty__title').count()) === 1);

console.log('\n【12】性能与错误');
const t0 = Date.now();
await page.goto(`${BASE}/#/440000/440100`, { waitUntil: 'networkidle' });
await waitReady(page);
const loadMs = Date.now() - t0;
check('直开广州市耗时 < 6s', loadMs < 6000, `${loadMs}ms`);
check('无控制台错误', errors.filter((e) => !e.includes('favicon')).length === 0, errors.slice(0, 2).join(' | '));

console.log('\n【12b】地区概览与攻略');
await page.goto(`${BASE}/#/330000/330100/330106`, { waitUntil: 'networkidle' });
await waitReady(page);
check('列表顶部显示地区概览', (await page.locator('.region-brief').count()) === 1);
const lead = (await page.locator('.region-brief__lead').innerText().catch(() => '')) ?? '';
check('概览带一句话定位', lead.length > 12, lead.slice(0, 20));
const chipCount = await page.locator('.rec-chip').count();
check('概览列出攻略推荐景点', chipCount >= 3, `${chipCount} 个`);
await page.screenshot({ path: `${SHOT_DIR}/14-region-brief.png` });

await page.locator('.region-brief__more').first().click();
await page.waitForTimeout(700);
check('打开地区介绍与攻略抽屉', (await page.locator('.drawer').count()) === 1);
const regionDrawerText = await page.locator('.drawer').innerText();
check('抽屉含地区介绍', regionDrawerText.includes('地区介绍'));
check('抽屉含旅游攻略', regionDrawerText.includes('旅游攻略'));
const recRows = await page.locator('.rec-row').count();
check('抽屉列出攻略推荐景点', recRows >= 3, `${recRows} 个`);
await page.screenshot({ path: `${SHOT_DIR}/15-region-drawer.png` });

await page.locator('.rec-row').first().click();
await page.waitForTimeout(1600);
check('点推荐景点后收起抽屉并高亮', (await page.locator('.drawer').count()) === 0);
check('推荐景点在列表中被选中', (await page.locator('.poi-card.is-active').count()) >= 1);

// 概览条那句定位默认折三行，真溢出了才出「展开全文」——不能让用户为了看半句话去开抽屉
await page.goto(`${BASE}/#/630000/630100`, { waitUntil: 'networkidle' });
await waitReady(page);
const expandBtn = page.locator('.region-brief__expand');
check('超长地区简介带「展开全文」', (await expandBtn.count()) === 1);
const foldedLead = await page.locator('.region-brief__lead').first().innerText();
await expandBtn.click();
await page.waitForTimeout(350);
check('展开后简介显示完整', (await page.locator('.region-brief__lead.is-expanded').count()) === 1);
check(
  '展开后内容不再被截断',
  (await page.locator('.region-brief__lead').first().innerText()).length >= foldedLead.length,
);
await page.screenshot({ path: `${SHOT_DIR}/16b-region-lead-expanded.png` });

// 省级概览的推荐通常不在本层级，点了要先跳到景点所在区县
await page.goto(`${BASE}/#/330000`, { waitUntil: 'networkidle' });
await waitReady(page);
const provinceChip = page.locator('.rec-chip', { hasText: '乌镇' }).first();
check('省级概览含跨市推荐（乌镇）', (await provinceChip.count()) === 1);
await provinceChip.click();
await page.waitForTimeout(2600);
check(
  '跨层级推荐点一下直达景点所在区县',
  (await page.evaluate(() => location.hash)) === '#/330000/330400/330483',
  await page.evaluate(() => location.hash),
);
check('面包屑同步到桐乡市', (await page.locator('.breadcrumb__current').innerText()) === '桐乡市');
await page.screenshot({ path: `${SHOT_DIR}/16-region-jump.png` });

// 抓不到 AI 卡的市由模型整理，界面必须标出来，不能跟搜来的混为一谈
await page.goto(`${BASE}/#/520000/522600`, { waitUntil: 'networkidle' });
await waitReady(page);
await page.locator('.region-brief__more').first().click();
await page.waitForTimeout(700);
const authoredBadge = await page.locator('.drawer__section--guide .guide-badge').innerText();
check('模型整理的攻略标注「AI 整理」', authoredBadge.trim() === 'AI 整理', authoredBadge.trim());
const authoredCite = await page.locator('.drawer__section--guide .drawer__cite').innerText();
check('模型整理注明来源与核实状态', authoredCite.includes('模型'), authoredCite.slice(0, 24));
check('模型整理的市也有可点击的推荐景点', (await page.locator('.rec-row').count()) >= 5);

// 区县介绍也有兜底：四平铁西区在百科只有沈阳的义项，介绍由模型补写，必须注明
await page.goto(`${BASE}/#/220000/220300/220302`, { waitUntil: 'networkidle' });
await waitReady(page);
await page.locator('.region-brief__more').first().click();
await page.waitForTimeout(700);
const modelIntro = await page.locator('.drawer__section', { hasText: '地区介绍' }).innerText();
check('百科无词条的区县有模型介绍', modelIntro.includes('四平'), modelIntro.slice(0, 26).replace(/\n/g, ' '));
check('模型介绍注明未经百科核实', modelIntro.includes('百科无独立词条'), '已注明');
await page.locator('[aria-label="关闭地区介绍"]').click();
await page.waitForTimeout(300);

// 百科接口的 abstract 有 400 字硬上限，会被切成「明称...」这种半句；
// 补全后的 intro 必须是一段读完的话，不能又断在省略号上
await page.goto(`${BASE}/#/130000`, { waitUntil: 'networkidle' });
await waitReady(page);
await page.locator('.region-brief__more').first().click();
await page.waitForTimeout(700);
const hebeiIntro = await page
  .locator('.drawer__section', { hasText: '地区介绍' })
  .locator('p')
  .first()
  .innerText();
check('地区介绍是完整版而非半句', !/(\.\.\.|…)\s*$/.test(hebeiIntro.trim()), hebeiIntro.slice(-18));
check('地区介绍长度已超过接口上限', hebeiIntro.length > 450, `${hebeiIntro.length} 字`);
await page.locator('[aria-label="关闭地区介绍"]').click();
await page.waitForTimeout(300);

// 港澳景点名是繁体、攻略正文是简体（「澳門威尼斯人 The Venetian Macau」vs「澳门威尼斯人」），
// 别名里不做繁简转换的话，路凼填海区 17 个度假村一个都推荐不出来。
await page.goto(`${BASE}/#/820000/820007`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.locator('.region-brief__more').click();
await page.waitForSelector('.drawer__section--guide');
await page.waitForTimeout(500);
const cotaiRecs = await page.locator('.rec-row').count();
check('繁体景点名也能匹配出推荐', cotaiRecs >= 3, `推荐 ${cotaiRecs} 个`);
const cotaiBadge = await page.locator('.drawer__section--guide .guide-badge').innerText();
check('百度无卡的地区标注为 AI 整理', cotaiBadge.includes('AI 整理'), cotaiBadge);
await page.locator('[aria-label="关闭地区介绍"]').click();
await page.waitForTimeout(300);

console.log('\n【13】移动端');
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await mobile.goto(`${BASE}/#/330000/330100/330106`, { waitUntil: 'networkidle' });
await mobile.waitForSelector('.map-overlay', { state: 'detached', timeout: 30000 }).catch(() => {});
await mobile.waitForTimeout(1500);
check('移动端地图视图可见', await mobile.locator('.map-canvas').isVisible());
await mobile.screenshot({ path: `${SHOT_DIR}/10-mobile-map.png` });
await mobile.locator('.mobile-tabs__btn', { hasText: '景点列表' }).click();
await mobile.waitForTimeout(500);
check('移动端切换到列表', await mobile.locator('.poi-card').first().isVisible());
await mobile.screenshot({ path: `${SHOT_DIR}/11-mobile-list.png` });

// 手机上整列才是滚动容器：以前只有 .panel-list 能滚，被标题/概览/筛选挤到几十像素高，
// 手指落在上半屏完全没反应
const mobileScroll = await mobile.evaluate(() => {
  const col = document.querySelector('.list-column');
  return {
    overflowY: getComputedStyle(col).overflowY,
    h: Math.round(col.clientHeight),
    scrollH: col.scrollHeight,
  };
});
check(
  '移动端整个列表列可滚动',
  mobileScroll.overflowY === 'auto' && mobileScroll.scrollH > mobileScroll.h + 200,
  JSON.stringify(mobileScroll),
);

const cdp = await mobile.context().newCDPSession(mobile);
const colBox = await mobile.locator('.list-column').boundingBox();
const swipeX = colBox.x + colBox.width / 2;
const swipeFrom = colBox.y + colBox.height * 0.55;
const swipeTo = colBox.y + colBox.height * 0.2;
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: swipeX, y: swipeFrom }] });
for (let i = 1; i <= 12; i += 1) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: swipeX, y: swipeFrom + ((swipeTo - swipeFrom) * i) / 12 }],
  });
  await mobile.waitForTimeout(16);
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await mobile.waitForTimeout(500);
const mobileScrolled = await mobile.evaluate(() => Math.round(document.querySelector('.list-column').scrollTop));
check('手指从概览区上滑也能滚动列表', mobileScrolled > 50, `scrollTop ${mobileScrolled}`);

await mobile.evaluate(() => {
  document.querySelector('.list-column').scrollTop = 1500;
});
await mobile.waitForTimeout(500);
check('滚深后出现「回到顶部」', await mobile.locator('.to-top').isVisible());
await mobile.locator('.to-top').click();
await mobile.waitForTimeout(700);
check(
  '点「回到顶部」回到列表顶端',
  (await mobile.evaluate(() => Math.round(document.querySelector('.list-column').scrollTop))) === 0,
);

// 换筛选等于换了一批结果，停在原位置会直接跳过后半段
await mobile.evaluate(() => {
  document.querySelector('.list-column').scrollTop = 400;
});
await mobile.waitForTimeout(300);
await mobile.locator('.chips--level .chip', { hasText: '5A' }).click();
await mobile.waitForTimeout(500);
check(
  '手机端换筛选后回到列表顶部',
  (await mobile.evaluate(() => Math.round(document.querySelector('.list-column').scrollTop))) === 0,
);
await mobile.locator('.chips--level .chip', { hasText: '不限' }).click();
await mobile.waitForTimeout(400);
await mobile.locator('.poi-card').first().click();
await mobile.waitForTimeout(600);
check('移动端打开详情抽屉', (await mobile.locator('.drawer').count()) === 1);
await mobile.screenshot({ path: `${SHOT_DIR}/12-mobile-detail.png` });
await mobile.locator('.drawer__foot .btn--ghost').click();
await mobile.waitForTimeout(400);
check('移动端关闭详情', (await mobile.locator('.drawer').count()) === 0);

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await waitReady(page);
await page.screenshot({ path: `${SHOT_DIR}/13-final-china.png` });

await browser.close();

console.log(`\n===== 结果：通过 ${pass} 项，失败 ${fail} 项 =====`);
if (fail) {
  console.log('失败项：');
  failures.forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
