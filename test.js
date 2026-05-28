const url = 'https://pedro-proyecto-backend.l7on3x.easypanel.host/api/onboarding/3cefd083-3247-4bbd-96d6-209df39657a7/step/7';
fetch(url, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ meals: [] })
}).then(async r => {
  console.log(r.status);
  console.log(await r.text());
}).catch(console.error);
