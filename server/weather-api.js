export function buildForecastUrl(lat, lon, days) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&hourly=cloud_cover,shortwave_radiation&timezone=auto&forecast_days=${days}`;
}

export function buildArchiveUrl(lat, lon, date) {
  return `https://archive-api.open-meteo.com/v1/archive?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&start_date=${date}&end_date=${date}&hourly=shortwave_radiation&timezone=auto`;
}

export async function fetchForecast(lat, lon, days = 1) {
  const url = buildForecastUrl(lat, lon, days);
  const resp = await fetch(url);
  return await resp.json();
}

export async function fetchArchive(lat, lon, date) {
  const url = buildArchiveUrl(lat, lon, date);
  const resp = await fetch(url);
  return await resp.json();
}
