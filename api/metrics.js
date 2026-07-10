const GHL_BASE = 'https://services.leadconnectorhq.com';
const LOC = '8ByMoOOq7hWWswablDhF';
const VERSION = '2021-07-28';

function headers() {
  return {
    Authorization: 'Bearer ' + process.env.GHL_TOKEN,
    Version: VERSION,
    Accept: 'application/json'
  };
}

async function ghlGet(path) {
  const res = await fetch(GHL_BASE + path, { headers: headers() });
  if (!res.ok) throw new Error('GHL GET ' + path + ' -> ' + res.status + ': ' + await res.text());
  return res.json();
}

async function ghlPost(path, body) {
  const res = await fetch(GHL_BASE + path, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('GHL POST ' + path + ' -> ' + res.status + ': ' + await res.text());
  return res.json();
}

// corre promesas con un límite de concurrencia para no saturar el rate limit de GHL (100/10s)
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(worker));
  return results;
}

const DIA_CORTO = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function buildBuckets(days, now) {
  const daily = days <= 14;
  const bucketCount = daily ? days : Math.ceil(days / 7);
  const bucketMs = daily ? 86400000 : 7 * 86400000;
  const buckets = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    const end = new Date(now.getTime() - i * bucketMs);
    const start = new Date(end.getTime() - bucketMs);
    const label = daily
      ? `${DIA_CORTO[start.getDay()]} ${start.getDate()}`
      : `${start.getDate()} ${MES_CORTO[start.getMonth()]}`;
    buckets.push({ start, end, label });
  }
  return buckets;
}

export default async function handler(req, res) {
  if (!process.env.GHL_TOKEN) {
    res.status(500).json({ error: 'Falta GHL_TOKEN en las variables de entorno de Vercel' });
    return;
  }

  const days = Math.max(1, parseInt(req.query.days || '7', 10));
  const platformsParam = (req.query.platforms || '').trim();
  const platforms = platformsParam ? platformsParam.split(',') : undefined;

  const now = new Date();
  const currentRange = { startDate: new Date(now.getTime() - days * 86400000).toISOString(), endDate: now.toISOString() };
  const prevRange = { startDate: new Date(now.getTime() - 2 * days * 86400000).toISOString(), endDate: currentRange.startDate };

  try {
    const [contactsPage, pipeData, accResp] = await Promise.all([
      ghlGet(`/contacts/?locationId=${LOC}&limit=1`),
      ghlGet(`/opportunities/pipelines?locationId=${LOC}`),
      ghlGet(`/social-media-posting/${LOC}/accounts`)
    ]);

    const totalContacts = contactsPage.meta.total;

    // leads nuevos por dia/semana dentro del rango (conteo liviano via filtro de fecha)
    const buckets = buildBuckets(days, now);
    const leadsPerPeriod = await mapLimit(buckets, 10, async (b) => {
      const r = await ghlPost('/contacts/search', {
        locationId: LOC,
        pageLimit: 1,
        filters: [{ field: 'dateAdded', operator: 'range', value: { gte: b.start.toISOString(), lte: b.end.toISOString() } }]
      });
      return { label: b.label, total: r.total };
    });
    const newLeadsInRange = leadsPerPeriod.reduce((s, b) => s + b.total, 0);

    // pipelines: total + por etapa, todo en paralelo (limitado)
    const stageJobs = [];
    pipeData.pipelines.forEach((p) => {
      p.stages.forEach((st) => {
        stageJobs.push({ pipelineId: p.id, pipelineName: p.name, stageId: st.id, stageName: st.name });
      });
    });
    const stageResults = await mapLimit(stageJobs, 15, async (job) => {
      const r = await ghlGet(
        `/opportunities/search?location_id=${LOC}&pipeline_id=${job.pipelineId}&pipeline_stage_id=${job.stageId}&limit=1`
      );
      return { ...job, total: r.meta.total };
    });

    const pipelinesMap = {};
    stageResults.forEach((r) => {
      if (!pipelinesMap[r.pipelineName]) pipelinesMap[r.pipelineName] = { name: r.pipelineName, total: 0, stages: [] };
      pipelinesMap[r.pipelineName].stages.push({ name: r.stageName, total: r.total });
      pipelinesMap[r.pipelineName].total += r.total;
    });
    const pipelines = Object.values(pipelinesMap).sort((a, b) => b.total - a.total);

    // redes sociales, con series por dia/semana que ya trae GHL
    const accounts = accResp.results.accounts || [];
    const social = await mapLimit(accounts, 6, async (acc) => {
      const body = { profileIds: [acc.profileId], currentRange, prevRange };
      if (platforms) body.platforms = platforms;
      const stats = await ghlPost(`/social-media-posting/statistics?locationId=${LOC}`, body);
      const r = stats.results;
      return {
        platform: acc.platform,
        name: acc.name,
        totals: r.totals,
        breakdowns: r.breakdowns,
        dayRange: r.dayRange,
        series: {
          impressions: r.postPerformance?.impressions || [],
          likes: r.postPerformance?.likes || [],
          comments: r.postPerformance?.comments || [],
          followers: r.platformTotals?.followers?.[acc.platform]?.series || []
        }
      };
    });

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=180');
    res.status(200).json({
      generatedAt: now.toISOString(),
      rangeDays: days,
      totalContacts,
      newLeadsInRange,
      leadsPerPeriod,
      pipelines,
      social
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
