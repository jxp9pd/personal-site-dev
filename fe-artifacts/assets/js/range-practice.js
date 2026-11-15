const buckets = [
  { min: 50, max: 75, weight: 3 },
  { min: 76, max: 100, weight: 3 },
  { min: 101, max: 125, weight: 3 },
  { min: 126, max: 150, weight: 3 },
  { min: 151, max: 175, weight: 2.75 },
  { min: 176, max: 200, weight: 2 },
  { min: 201, max: 250, weight: 7 },
];
const totalWeight = buckets.reduce((sum, bucket) => sum + bucket.weight, 0);

export function sampleShots(count, random = Math.random) {
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    throw new RangeError('Choose between 1 and 200 shots.');
  }
  return Array.from({ length: count }, () => {
    let pick = random() * totalWeight;
    const bucket = buckets.find(({ weight }) => {
      pick -= weight;
      return pick < 0;
    });
    return bucket.min + Math.floor(random() * (bucket.max - bucket.min + 1));
  });
}

export function mountSampler(root = document) {
  const form = root.querySelector('#range-form');
  const count = root.querySelector('#shot-count');
  const list = root.querySelector('#shot-list');
  const status = root.querySelector('#range-status');

  function generate(event) {
    event?.preventDefault();
    if (!form.reportValidity()) return;
    const shots = sampleShots(count.valueAsNumber);
    list.replaceChildren(...shots.map((distance, index) => {
      const item = list.ownerDocument.createElement('li');
      item.innerHTML = `<span class="shot-index">${String(index + 1).padStart(2, '0')}</span><span class="shot-distance">${distance}<span class="shot-unit">yd</span></span>`;
      return item;
    }));
    status.textContent = `${shots.length} ${shots.length === 1 ? 'shot' : 'shots'} · 50–250 yards`;
  }

  form.addEventListener('submit', generate);
  generate();
}
