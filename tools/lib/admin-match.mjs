/**
 * 行政区名称 → adcode 映射（供省级名录落界用）
 *
 * 名录里的写法极不规范：
 *   福建  地市列「福州市」+ 区县列「鼓楼区」
 *   河北  只有一列「石家庄市平山县」
 *   还有「宁德市屏南县」「龙岩、漳州」这种一景跨市
 *
 * 这里用项目自带的 public/geo/index.json 建立名称索引，做最长匹配拆分。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** 地名归一：去掉空格、括号备注，统一「区/县/市」写法 */
function normName(name) {
  return String(name ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s　]/g, '')
    .trim();
}

/**
 * 剥离民族名：名录里「文山壮族苗族自治州」常写成「文山州」，
 * 「红河哈尼族彝族自治州」写成「红河」，不多生成一套简称就匹配不上。
 */
const NATIONS =
  /(蒙古族|回族|藏族|维吾尔|苗族|彝族|壮族|布依族|朝鲜族|满族|侗族|瑶族|白族|土家族|哈尼族|哈萨克族|傣族|黎族|傈僳族|佤族|畲族|拉祜族|水族|东乡族|纳西族|景颇族|柯尔克孜族|土族|达斡尔族|仫佬族|羌族|布朗族|撒拉族|毛南族|仡佬族|锡伯族|阿昌族|普米族|塔吉克族|怒族|乌孜别克族|俄罗斯族|鄂温克族|德昂族|保安族|裕固族|京族|塔塔尔族|独龙族|鄂伦春族|赫哲族|门巴族|珞巴族|基诺族)/g;

export function createAdminIndex(geoIndexPath = path.join(ROOT, 'public', 'geo', 'index.json')) {
  const index = JSON.parse(fs.readFileSync(geoIndexPath, 'utf8'));
  // nodes: [adcode, name, parentAdcode, level]
  const nodes = new Map();
  for (const [adcode, name, parent, level] of index.nodes) {
    nodes.set(Number(adcode), { adcode: Number(adcode), name, parent: parent ? Number(parent) : null, level });
  }

  const provinces = []; // { adcode, name, short }
  const cities = [];
  const districts = [];

  for (const node of nodes.values()) {
    if (node.level === 1) provinces.push(node);
    else if (node.level === 2) cities.push(node);
    else if (node.level === 3) districts.push(node);
  }

  const byCityName = new Map();
  for (const c of cities) {
    const keys = new Set([normName(c.name)]);
    // 「杭州市」→「杭州」；「阿坝藏族羌族自治州」→「阿坝」
    keys.add(normName(c.name).replace(/(市|地区|自治州|盟)$/, ''));
    keys.add(normName(c.name).replace(/(地区|自治州|盟)$/, ''));
    // 「文山壮族苗族自治州」→「文山自治州」→「文山」；名录里常只写「文山州」
    const stripped = normName(c.name).replace(NATIONS, '');
    keys.add(stripped);
    keys.add(stripped.replace(/(自治州|自治县|地区|盟|州|市|县|区)$/, ''));
    for (const k of keys) if (k) byCityName.set(k, c);
  }

  const districtsByParent = new Map();
  for (const d of districts) {
    const list = districtsByParent.get(d.parent) ?? [];
    list.push(d);
    districtsByParent.set(d.parent, list);
  }

  const byDistrictName = new Map(); // 同名的区县很多（鼓楼区、朝阳区），值是数组
  for (const d of districts) {
    const full = normName(d.name);
    // 「互助土族自治县」名录里常简写成「互助县」或「互助」，去民族名后两种都能对上；
    // 「河南蒙古族自治县」又常被写成「河南蒙古自治县」（少个「族」），所以再去一次「族」字
    const noNation = full.replace(NATIONS, '');
    const keys = new Set([full, noNation, full.replace(/族/g, ''), noNation.replace(/族/g, '')]);
    keys.add(full.replace(/(市|县|区|旗|自治县|自治旗)$/, ''));
    keys.add(noNation.replace(/(市|县|区|旗|自治县|自治旗)$/, ''));
    for (const k of keys) {
      if (!k) continue;
      const list = byDistrictName.get(k) ?? [];
      list.push(d);
      byDistrictName.set(k, list);
    }
  }

  const byProvinceName = new Map();
  for (const p of provinces) {
    const keys = new Set([normName(p.name)]);
    keys.add(normName(p.name).replace(/(省|市|自治区|壮族|回族|维吾尔|特别行政区)/g, ''));
    for (const k of keys) if (k && k.length >= 2) byProvinceName.set(k, p);
  }

  /** 在一个字符串开头找地级市 */
  function matchCityPrefix(text) {
    const s = normName(text);
    if (!s) return null;
    // 从长到短尝试
    for (let len = Math.min(s.length, 12); len >= 2; len--) {
      const head = s.slice(0, len);
      const city = byCityName.get(head);
      if (city) return { city, rest: s.slice(len) };
    }
    return null;
  }

  /** 直辖市：省即市，城市列表里没有，单独处理 */
  const MUNICIPALITIES = new Set([110000, 120000, 310000, 500000]);

  /**
   * 解析一条名录记录所属行政区
   * @param {{province: string, cityName: string, districtName: string}} input
   * @returns {{adcode:number, path:number[], city:string, district:string, level:'exact'|'approx'} | null}
   */
  /** 区县名的两种写法：「江华瑶族自治县」和「江华县」 */
  const districtKeys = (name) => {
    const s = normName(name);
    if (!s) return [];
    const noSuffix = s.replace(/(自治县|自治旗|市|县|区|旗)$/, '');
    // 正反两个方向都试：「互助土族自治县」和「互助县」要能互相找到
    return [
      ...new Set([
        s,
        noSuffix,
        s.replace(NATIONS, ''),
        noSuffix.replace(NATIONS, ''),
        s.replace(/族/g, ''),
      ]),
    ].filter((k) => k.length >= 2);
  };

  const belongsTo = (d, ancestorAdcode) => {
    let cur = d;
    for (let i = 0; i < 4 && cur; i++) {
      if (cur.adcode === ancestorAdcode) return true;
      cur = nodes.get(cur.parent);
    }
    return false;
  };

  const findDistrictInProvince = (name, provinceAdcode) => {
    for (const key of districtKeys(name)) {
      const hit = (byDistrictName.get(key) ?? []).find((d) => belongsTo(d, provinceAdcode));
      if (hit) return hit;
    }
    return null;
  };

  const findDistrictInCity = (name, cityAdcode) => {
    for (const key of districtKeys(name)) {
      const hit = (byDistrictName.get(key) ?? []).find((d) => d.parent === cityAdcode);
      if (hit) return hit;
    }
    return null;
  };

  /** 在全省范围内找出现在串中的区县全名，取最长匹配（不带市名时的兜底） */
  const findDistrictAnywhere = (text, provinceAdcode) => {
    const s = normName(text);
    if (s.length < 3) return null;
    let best = null;
    for (const d of districts) {
      const full = normName(d.name);
      if (full.length < 3 || !s.includes(full)) continue;
      if (!belongsTo(d, provinceAdcode)) continue;
      if (!best || full.length > normName(best.name).length) best = d;
    }
    return best;
  };

  /** 区县全名出现在串的任意位置（地址常写成「距离XX县城N公里」） */
  const findDistrictInText = (text, cityAdcode) => {
    const s = normName(text);
    if (!s) return null;
    let best = null;
    for (const d of districtsByParent.get(cityAdcode) ?? []) {
      const full = normName(d.name);
      if (full.length < 3 || !s.includes(full)) continue;
      if (!best || full.length > normName(best.name).length) best = d;
    }
    return best;
  };

  /**
   * 按前缀找区县：地址抠出来的串后面总跟着镇村门牌
   * （「祁连县野牛沟油葫芦口」「湟中区鲁沙尔镇」），精确匹配对不上，只能取最长前缀。
   * 只认带「区/县/市/旗」的全名，避免「祁连」这种简称误配。
   */
  const findDistrictByPrefix = (name, cityAdcode) => {
    const s = normName(name);
    if (!s) return null;
    let best = null;
    for (const d of districtsByParent.get(cityAdcode) ?? []) {
      const full = normName(d.name);
      if (full.length < 2 || !s.startsWith(full)) continue;
      if (!best || full.length > normName(best.name).length) best = d;
    }
    return best;
  };

  function resolve({ province, cityName, districtName }) {
    const provinceNode = byProvinceName.get(normName(province)) ?? null;
    if (!provinceNode) return null;
    const provinceAdcode = provinceNode.adcode;
    const isMunicipality = MUNICIPALITIES.has(provinceAdcode);

    let cityNode = null;
    let restDistrict = normName(districtName);

    const rawCity = normName(cityName);
    const rawDistrict = normName(districtName);

    // 0) 城市列填的其实是区县（湖南写「耒阳市」「长沙县」「宁乡市」），
    // 直接按区县定位；否则「衡阳县」会被 matchCityPrefix 拆成「衡阳市」+「县」
    if (rawCity && /(市|县|区|旗)$/.test(rawCity)) {
      const asDistrict = findDistrictInProvince(rawCity, provinceAdcode);
      if (asDistrict) {
        return {
          adcode: asDistrict.adcode,
          path: chainOf(asDistrict.adcode),
          city: nodes.get(asDistrict.parent)?.name ?? '',
          district: asDistrict.name,
          level: 'exact',
        };
      }
    }

    // 1) 城市列里可能塞了「石家庄市平山县」
    if (rawCity) {
      const hit = matchCityPrefix(rawCity);
      // 「长沙县」被拆成「长沙市」+「县」，是把区县名的尾字当成了城市后缀；
      // 但「湘西州」拆成「湘西」+「州」是同一个地名的两种写法，残渣可以丢
      const loneTail = hit && /^[市县区旗州]$/.test(hit.rest);
      const cityIsDistrict = loneTail && findDistrictInProvince(rawCity, provinceAdcode);
      if (hit && !cityIsDistrict) {
        cityNode = hit.city;
        const tail = loneTail ? '' : hit.rest;
        // 区县列已经给出本市的真区县时不要再拼（「株洲醴陵市」会拼成「醴陵市醴陵市」）
        if (tail && !findDistrictInCity(restDistrict, cityNode.adcode)) {
          restDistrict = restDistrict.startsWith(tail) ? restDistrict : tail + restDistrict;
        }
      } else if (isMunicipality) {
        // 直辖市的地名常写成「密云区」「延庆县」，直接当区县
        restDistrict = rawCity + restDistrict;
      }
    }

    // 2) 城市没识别出来，可能是直辖市 + 只有区县列
    if (!cityNode && isMunicipality) {
      cityNode = nodes.get(provinceAdcode) ?? null;
      if (isMunicipality && rawDistrict) restDistrict = rawDistrict || restDistrict;
    }

    // 2.5) 有些名录的「所在地」列填的是县级市/区（湖南写「宁乡市」「浏阳市」），
    // 这些在行政区划里属于第三级，按城市匹配必然落空，改当区县反查
    if (!cityNode && !restDistrict && rawCity) restDistrict = rawCity;

    // 3.0) 没有城市列、区县又是从整串地址抠出来的（青海年鉴「海北州祁连县野牛沟」），
    // 这串地名的开头往往就是市州
    if (!cityNode && restDistrict) {
      const hit = matchCityPrefix(restDistrict);
      if (hit) {
        cityNode = hit.city;
        // 「海北」+「州祁连县…」：市名简称后面的单字后缀是残渣；
        // 整串就是城市名（地址只写到市）时 rest 为空，落到市本级即可
        restDistrict = hit.rest.replace(/^[州市县区盟]/, '');
      }
    }

    // 3) 城市没识别，从区县名反查（同名区县按省份过滤）
    if (!cityNode && restDistrict) {
      const d = findDistrictInProvince(restDistrict, provinceAdcode);
      if (d) {
        return { adcode: d.adcode, path: chainOf(d.adcode), city: nodes.get(d.parent)?.name ?? '', district: d.name, level: 'exact' };
      }
      // 「距离祁连县城9公里」这类地址，区县名藏在串中间，按包含关系全省捞一次
      const anywhere = findDistrictAnywhere(restDistrict, provinceAdcode);
      if (anywhere) {
        return {
          adcode: anywhere.adcode,
          path: chainOf(anywhere.adcode),
          city: nodes.get(anywhere.parent)?.name ?? '',
          district: anywhere.name,
          level: 'exact',
        };
      }
    }

    if (!cityNode) return null;

    // 地址抠出来的区县常带着市名（贵州「贵州省贵阳市花溪区…」→「贵阳市花溪区」），
    // 先去掉市名前缀再比对。剥完必须仍是个真区县，
    // 否则「岳阳楼区」会被「岳阳」啃成「楼区」
    if (restDistrict) {
      const cityFull = normName(cityNode.name);
      const cityShort = cityFull.replace(/(市|地区|自治州|盟)$/, '');
      for (const key of [cityFull, cityShort]) {
        if (key.length >= 2 && restDistrict.startsWith(key)) {
          const rest = restDistrict.slice(key.length);
          if (rest.length >= 2 && findDistrictInCity(rest, cityNode.adcode)) restDistrict = rest;
          break;
        }
      }
    }

    // 4) 区县匹配：先在城市下精确找，再按前缀放宽
    if (restDistrict) {
      for (const key of [restDistrict, restDistrict.replace(/(市|县|区|旗)$/, '')]) {
        const cands = byDistrictName.get(key) ?? [];
        const hit = cands.find((d) => d.parent === cityNode.adcode);
        if (hit) {
          return {
            adcode: hit.adcode,
            path: chainOf(hit.adcode),
            city: cityNode.name,
            district: hit.name,
            level: 'exact',
          };
        }
      }
      // 地址串带镇村后缀（「祁连县野牛沟油葫芦口」），精确匹配对不上，退到前缀
      const prefixed = findDistrictByPrefix(restDistrict, cityNode.adcode);
      if (prefixed) {
        return {
          adcode: prefixed.adcode,
          path: chainOf(prefixed.adcode),
          city: cityNode.name,
          district: prefixed.name,
          level: 'exact',
        };
      }
      // 地址把区县写在中间（「距离祁连县城9公里」「海北州西海镇」），前缀对不上，
      // 就在本市区县里找出现在串中的全名，取最长的那个
      const mentioned = findDistrictInText(restDistrict, cityNode.adcode);
      if (mentioned) {
        return {
          adcode: mentioned.adcode,
          path: chainOf(mentioned.adcode),
          city: cityNode.name,
          district: mentioned.name,
          level: 'exact',
        };
      }
    }

    // 5) 只有城市：落到市本级（adcode 用市）
    return {
      adcode: cityNode.adcode,
      path: chainOf(cityNode.adcode),
      city: cityNode.name,
      district: '',
      level: 'approx',
    };
  }

  /**
   * 从景区名称前缀推区县
   *
   * 很多省的名录只有「市」一列（山西 / 河南 / 云南 / 内蒙古 的 PDF，辽宁的 xlsx），
   * 但景区名本身常把区县写在开头：
   *   山西「清徐县六味斋云梦坞景区」「万柏林区中国煤炭博物馆…景区」
   *   河南「登封嵩山少林景区」「登封中岳庙景区」
   * 只在该市自己的区县里找，避免「西山景区」被认成外省的西山区。
   *
   * @returns {string} 命中的区县正式名，未命中返回空串
   */
  function guessDistrict(province, cityName, name) {
    const s = normName(name);
    if (!s) return '';
    const provinceNode = byProvinceName.get(normName(province)) ?? null;
    if (!provinceNode) return '';

    let cityNode = null;
    const rawCity = normName(cityName);
    if (rawCity) cityNode = matchCityPrefix(rawCity)?.city ?? null;
    if (!cityNode && MUNICIPALITIES.has(provinceNode.adcode)) cityNode = nodes.get(provinceNode.adcode) ?? null;
    // 没有市就退回全省，命中率低但聊胜于无
    const pool = cityNode
      ? (districtsByParent.get(cityNode.adcode) ?? [])
      : districts.filter((d) => {
          let cur = d;
          for (let i = 0; i < 4 && cur; i++) {
            if (cur.adcode === provinceNode.adcode) return true;
            cur = nodes.get(cur.parent);
          }
          return false;
        });
    if (!pool.length) return '';

    const cands = [];
    for (const d of pool) {
      const full = normName(d.name);
      if (full.length >= 2) cands.push({ d, key: full, exact: true });
      const short = full.replace(/(自治县|自治旗|市|县|区|旗)$/, '');
      if (short.length >= 2 && short !== full) cands.push({ d, key: short, exact: false });
    }
    // 长名优先：有「清徐县」就不要先试「清徐」
    cands.sort((a, b) => b.key.length - a.key.length || Number(b.exact) - Number(a.exact));

    const attempt = (text) => {
      for (const { d, key, exact } of cands) {
        if (!text.startsWith(key)) continue;
        const rest = text.slice(key.length);
        if (!rest) continue; // 名字就是区县名本身，不是景区
        // 简称命中要求后面至少还有两个字，否则「东湖」这种容易误判；
        // 而且后面不能接着「市/县/区」，那说明这半个是地名不是区县简称
        // （「湘潭市博物馆」不该认成湘潭县）
        if (!exact && (rest.length < 2 || /^[市县区旗]/.test(rest))) continue;
        return d.name;
      }
      return '';
    };

    const direct = attempt(s);
    if (direct) return direct;

    // 河南这类名录把「市」写进景区名开头（「郑州嵩阳书院景区」），
    // 剥掉市名后仍可能在后面接区县（「郑州惠济区…」），再试一次
    if (cityNode) {
      const cityFull = normName(cityNode.name);
      const cityShort = cityFull.replace(/(市|地区|自治州|盟)$/, '');
      for (const key of [cityFull, cityShort]) {
        if (key.length >= 2 && s.startsWith(key) && s.length - key.length >= 4) {
          const second = attempt(s.slice(key.length));
          if (second) return second;
        }
      }
    }
    return '';
  }

  /**
   * 「汉寿县湖南常德野生动物世界景区常德市」→ { head: '汉寿县…景区', city: '常德市' }
   * doc 里合并单元格会把景区名和所在地粘成一格，只能靠尾部城市名反拆。
   */
  function splitTrailingCity(text) {
    const s = normName(text);
    if (s.length < 4) return null;
    for (let len = Math.min(s.length - 2, 12); len >= 2; len--) {
      const city = byCityName.get(s.slice(-len));
      if (city) {
        const head = s.slice(0, s.length - len);
        if (head.length >= 2) return { head, city: city.name };
        return null;
      }
    }
    return null;
  }

  /** 整串就是一个行政区名（分组小标题「岳阳市」「雁峰区」），不是景区 */
  function isAdminName(text) {
    const s = normName(text);
    if (!s) return false;
    return byCityName.has(s) || (byDistrictName.get(s)?.length ?? 0) > 0;
  }

  function chainOf(adcode) {
    const out = [];
    let cur = nodes.get(Number(adcode));
    let guard = 0;
    while (cur && guard++ < 6) {
      out.unshift(cur.adcode);
      cur = cur.parent ? nodes.get(cur.parent) : null;
    }
    return out;
  }

  return { nodes, provinces, cities, districts, resolve, guessDistrict, splitTrailingCity, isAdminName, chainOf, normName };
}
