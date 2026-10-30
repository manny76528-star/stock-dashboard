export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname.slice(1);

    // ── 🔐 通行碼檢查（2026/10 新增）──
    //   查股價(price)、大盤(index)維持公開；讀寫資料、AI 分析都要帶正確的 X-Sync-Key
    //   Cloudflare 設定裡還沒放 SYNC_KEY_HASH 之前，一律放行（跟以前一樣），方便先換程式再上鎖
    if (path !== 'price' && path !== 'index' && env.SYNC_KEY_HASH) {
      const key = request.headers.get('X-Sync-Key') || '';
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
      const got = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
      const want = String(env.SYNC_KEY_HASH).trim().toLowerCase();
      let diff = got.length ^ want.length;
      for (let i = 0; i < Math.min(got.length, want.length); i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
      if (!key || diff !== 0) {
        return new Response(JSON.stringify({ error: 'auth' }), {
          status: 401, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
    }

    const twseHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.twse.com.tw/',
      'Accept': 'application/json, text/plain, */*'
    };

    // ── AI 分析代理 ──
    if (path === 'ai' && request.method === 'POST') {
      try {
        const body = await request.json();
        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) return new Response(JSON.stringify({error:'no api key'}), {
          status:500, headers:{...cors,'Content-Type':'application/json'}
        });
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify(body)
        });
        const data = await resp.json();
        return new Response(JSON.stringify(data), {
          status: resp.status,
          headers: {...cors, 'Content-Type': 'application/json'}
        });
      } catch(e) {
        return new Response(JSON.stringify({error: e.message}), {
          status: 500, headers: {...cors, 'Content-Type': 'application/json'}
        });
      }
    }

    // ── 台股加權指數 ──
    if (path === 'index') {
      try {
        let price = null;
        try {
          const res = await fetch('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0', { headers: twseHeaders });
          if (res.ok) {
            const data = await res.json();
            const item = data?.msgArray?.[0];
            if (item) {
              const prev = parseFloat(item.y);
              if (item.z && item.z !== '-' && item.z !== '') {
                price = parseFloat(item.z);
              } else if (!isNaN(prev) && prev > 0) {
                price = prev;
              }
            }
          }
        } catch(e) {}
        if (!price) {
          try {
            const today = new Date();
            for (let mo = 0; mo <= 1 && !price; mo++) {
              const d = new Date(today.getFullYear(), today.getMonth() - mo, 1);
              const dateStr = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}01`;
              const r = await fetch(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo=t00&date=${dateStr}&response=json`, { headers: twseHeaders });
              if (r.ok) {
                const data = await r.json();
                const rows = data?.data;
                if (rows && rows.length > 0) {
                  const v = rows[rows.length-1][6]?.replace(/,/g,'');
                  if (v && v !== '--') price = parseFloat(v);
                }
              }
            }
          } catch(e) {}
        }
        if (price) {
          return new Response(JSON.stringify({ price, ts: Date.now() }), {
            headers: {...cors, 'Content-Type': 'application/json'}
          });
        } else {
          return new Response(JSON.stringify({error:'no data'}), {
            status: 404, headers: {...cors, 'Content-Type': 'application/json'}
          });
        }
      } catch(e) {
        return new Response(JSON.stringify({error: e.message}), {
          status: 500, headers: {...cors, 'Content-Type': 'application/json'}
        });
      }
    }

    // ── 即時股價 ──
    if (path === 'price') {
      const code = url.searchParams.get('code');
      if (!code) return new Response(JSON.stringify({error:'no code'}), {
        headers:{...cors,'Content-Type':'application/json'}
      });
      try {
        let price = null, change = null, changePct = null;
        const hasAlpha = /[A-Za-z]/.test(code);
        const exchanges = hasAlpha ? ['otc', 'tse'] : ['tse', 'otc'];
        for (const ex of exchanges) {
          if (price) break;
          try {
            const apiUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${ex}_${code}.tw&json=1&delay=0`;
            const res = await fetch(apiUrl, { headers: twseHeaders });
            if (res.ok) {
              const data = await res.json();
              const item = data?.msgArray?.[0];
              if (item) {
                const prev = parseFloat(item.y);
                if (item.z && item.z !== '-' && item.z !== '') {
                  price = parseFloat(item.z);
                  if (!isNaN(price) && !isNaN(prev) && prev > 0) {
                    change = Math.round((price - prev) * 100) / 100;
                    changePct = Math.round((price - prev) / prev * 10000) / 100;
                  }
                } else if (!isNaN(prev) && prev > 0) {
                  price = prev;
                  change = 0;
                  changePct = 0;
                }
              }
            }
          } catch(e) {}
        }
        if (!price) {
          try {
            const tpexUrl = `https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes?stockNo=${code}`;
            const tpexRes = await fetch(tpexUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tpex.org.tw/' }
            });
            if (tpexRes.ok) {
              const tpexData = await tpexRes.json();
              const item = tpexData?.find?.(x =>
                x.SecuritiesCompanyCode === code ||
                x.SecuritiesCompanyCode === code.toUpperCase()
              );
              if (item && item.Close && item.Close !== '-' && item.Close !== '') {
                price = parseFloat(item.Close);
                const prev = parseFloat(item.PreviousClose);
                if (!isNaN(price) && !isNaN(prev) && prev > 0) {
                  change = Math.round((price - prev) * 100) / 100;
                  changePct = Math.round((price - prev) / prev * 10000) / 100;
                }
              }
            }
          } catch(e) {}
        }
        if (!price) {
          try {
            const today = new Date();
            for (let monthOffset = 0; monthOffset <= 1 && !price; monthOffset++) {
              const d = new Date(today.getFullYear(), today.getMonth() - monthOffset, 1);
              const dateStr = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}01`;
              const twseUrl = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo=${code}&date=${dateStr}&response=json`;
              const twseRes = await fetch(twseUrl, { headers: twseHeaders });
              if (twseRes.ok) {
                const twseData = await twseRes.json();
                const rows = twseData?.data;
                if (rows && rows.length > 0) {
                  const last = rows[rows.length - 1];
                  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
                  const closeStr = last[6]?.replace(/,/g, '');
                  if (closeStr && closeStr !== '--' && closeStr !== '') {
                    price = parseFloat(closeStr);
                    const prevCloseStr = prev ? prev[6]?.replace(/,/g, '') : null;
                    if (prevCloseStr && prevCloseStr !== '--') {
                      const prevClose = parseFloat(prevCloseStr);
                      if (!isNaN(price) && !isNaN(prevClose) && prevClose > 0) {
                        change = Math.round((price - prevClose) * 100) / 100;
                        changePct = Math.round((price - prevClose) / prevClose * 10000) / 100;
                      }
                    }
                  }
                }
              }
            }
          } catch(e) {}
        }
        if (price && !isNaN(price)) {
          return new Response(JSON.stringify({
            price, change: change||0, changePct: changePct||0, ts: Date.now()
          }), { headers: {...cors, 'Content-Type': 'application/json'} });
        } else {
          return new Response(JSON.stringify({error:'no data'}), {
            status: 404, headers: {...cors, 'Content-Type': 'application/json'}
          });
        }
      } catch(e) {
        return new Response(JSON.stringify({error: e.message}), {
          status: 500, headers: {...cors, 'Content-Type': 'application/json'}
        });
      }
    }

    // ── GitHub 同步 ──
    const token = env.GH_TOKEN;
    if (!token) {
      return new Response(JSON.stringify({error:'no token'}), {
        status: 500, headers: {...cors, 'Content-Type': 'application/json'}
      });
    }
    const allowed = path.endsWith('.json')
      || path.startsWith('glove-images/')
      || path.startsWith('journal-images/')
      || path.startsWith('order-images/');
    if (!path || !allowed) {
      return new Response(JSON.stringify({error:'invalid file'}), {
        status: 400, headers: {...cors, 'Content-Type': 'application/json'}
      });
    }
    const ghUrl = `https://api.github.com/repos/manny76528-star/stock-dashboard/contents/${path}`;
    if (request.method === 'GET') {
      const r = await fetch(ghUrl + '?t=' + Date.now(), {
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'dashboard-sync'
        }
      });
      const body = await r.text();
      return new Response(body, {
        status: r.status,
        headers: {...cors, 'Content-Type': 'application/json'}
      });
    }
    if (request.method === 'PUT') {
      const body = await request.text();
      const r = await fetch(ghUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `token ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'dashboard-sync'
        },
        body
      });
      const resp = await r.text();
      return new Response(resp, {
        status: r.status,
        headers: {...cors, 'Content-Type': 'application/json'}
      });
    }
    return new Response(JSON.stringify({error:'method not allowed'}), {
      status: 405, headers: {...cors, 'Content-Type': 'application/json'}
    });
  }
};