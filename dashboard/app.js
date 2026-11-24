(() => {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const data = globalThis.RADAR_DATA;
  if (!data) {
    byId('load-error').hidden = false;
    byId('board-view').hidden = true;
    return;
  }

  const allRanked = new Map(data.ranked.map((row) => [row.slug, row]));
  const rankedTab = byId('ranked-tab');
  const tradingTab = byId('trading-tab');
  const board = byId('board-view');
  const detail = byId('detail-view');
  const method = byId('method');
  const query = byId('query');
  const category = byId('category');
  const chain = byId('chain');
  const sort = byId('sort');
  const uncategorized = 'Uncategorized';
  const pageSize = 12;
  const full = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
  const countFormat = new Intl.NumberFormat('en-US');
  const signs = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2, signDisplay: 'exceptZero' });
  const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
  const money = (value) => value === null ? 'Unreported' : compact.format(value);
  const change = (value) => value === null ? 'Unreported' : `${signs.format(value)}%`;
  const tenure = (value) => value === null ? 'Unknown' : `${countFormat.format(value)} d`;
  const movement = (value) => value === null ? 'unknown' : value > 0 ? 'up' : value < 0 ? 'down' : '';
  const categoryName = (row) => row.category ?? uncategorized;
  const date = (value) => dateFormat.format(new Date(value));

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function link(href, className, content) {
    const node = element('a', className, content);
    node.href = href;
    return node;
  }

  const detailHash = (slug) => `#protocol/${encodeURIComponent(slug)}`;
  let mode = 'board';
  let order = 'implied_value_usd';
  let direction = 'desc';
  let page = 1;
  let lastBoardHash = '#board';
  let tableRows = data.ranked;

  const commonOrders = [
    ['tvl_usd', 'TVL'],
    ['change_7d', '7-day change'],
    ['tenure_days', 'Tracking tenure'],
  ];
  const labels = {
    implied_value_usd: 'Implied value', tvl_usd: 'TVL', change_7d: '7D TVL',
    tenure_days: 'Tracked', name: 'Protocol', mcap_usd: 'Market cap',
  };

  function setOptions(control, entries) {
    control.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
  }

  function setSelect(control, value) {
    if (Array.from(control.options).some((option) => option.value === value)) control.value = value;
  }

  function orders(nextMode) {
    return nextMode === 'trading'
      ? [['name', 'Protocol name'], ['mcap_usd', 'Market cap'], ...commonOrders]
      : [['implied_value_usd', 'Implied value'], ...commonOrders];
  }

  function configureFilters(nextMode) {
    tableRows = nextMode === 'trading' ? data.trading : data.ranked;
    const categories = [...new Set(tableRows.map(categoryName))].sort();
    const chains = [...new Set(tableRows.flatMap((row) => row.chains))].sort();
    setOptions(category, [['', 'All categories'], ...categories.map((value) => [value, value])]);
    setOptions(chain, [['', 'All chains'], ...chains.map((value) => [value, value])]);
    setOptions(sort, orders(nextMode));
  }

  function loadControls(params) {
    category.selectedIndex = 0;
    chain.selectedIndex = 0;
    sort.selectedIndex = 0;
    query.value = params.get('q') ?? '';
    setSelect(category, params.get('category'));
    setSelect(chain, params.get('chain'));
    setSelect(sort, params.get('sort'));
    order = sort.value;
    direction = params.get('direction') === 'asc' || (order === 'name' && params.get('direction') !== 'desc') ? 'asc' : 'desc';
    const requestedPage = Number(params.get('page'));
    page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  }

  function keepBoardHash() {
    const params = new URLSearchParams();
    if (query.value.trim()) params.set('q', query.value.trim());
    if (category.value) params.set('category', category.value);
    if (chain.value) params.set('chain', chain.value);
    if (order !== orders(mode)[0][0]) params.set('sort', order);
    if (direction !== (order === 'name' ? 'asc' : 'desc')) params.set('direction', direction);
    if (page > 1) params.set('page', String(page));
    lastBoardHash = `#${mode}${params.size ? `?${params}` : ''}`;
    if (location.hash !== lastBoardHash) history.replaceState(null, '', lastBoardHash);
  }

  function setActiveTab(trading) {
    rankedTab.removeAttribute('aria-current');
    tradingTab.removeAttribute('aria-current');
    (trading ? tradingTab : rankedTab).setAttribute('aria-current', 'page');
  }

  function drawChart() {
    const canvas = byId('rank-chart');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    const width = canvas.width / 2;
    const height = canvas.height / 2;
    const x0 = 44;
    const x1 = width - 20;
    const y0 = 12;
    const y1 = height - 23;
    const scores = data.ranked.map((row) => Math.log10(row.implied_value_usd));
    const lo = Math.floor(Math.min(...scores));
    const hi = Math.ceil(Math.max(...scores));
    const x = (index) => x0 + (x1 - x0) * index / (scores.length - 1);
    const y = (value) => y1 - (y1 - y0) * (value - lo) / (hi - lo);
    ctx.clearRect(0, 0, width, height);
    ctx.font = '10px monospace';
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    for (let tick = lo; tick <= hi; tick += 1) {
      const lineY = y(tick);
      ctx.strokeStyle = '#344b68';
      ctx.beginPath();
      ctx.moveTo(x0, lineY);
      ctx.lineTo(x1, lineY);
      ctx.stroke();
      ctx.fillStyle = '#b8cbe5';
      ctx.textAlign = 'right';
      ctx.fillText(money(10 ** tick), x0 - 8, lineY);
    }
    ctx.strokeStyle = '#7192c4';
    ctx.beginPath();
    scores.forEach((score, index) => index === 0 ? ctx.moveTo(x(index), y(score)) : ctx.lineTo(x(index), y(score)));
    ctx.stroke();
    scores.forEach((score, index) => {
      ctx.beginPath();
      ctx.fillStyle = data.ranked[index].watchlist ? '#a0d5ff' : '#6384be';
      ctx.arc(x(index), y(score), data.ranked[index].watchlist ? 2.2 : 1.6, 0, Math.PI * 2);
      ctx.fill();
    });
    for (const index of [0, 49, 99, 149, scores.length - 1]) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#b8cbe5';
      ctx.fillText(`#${index + 1}`, x(index), height - 9);
    }
  }

  function populateSummary() {
    byId('snapshot-date').textContent = `Snapshot · ${date(data.as_of)}`;
    byId('footer-source').textContent = `DefiLlama sealed snapshot · ${date(data.as_of)}`;
    const stats = [
      [data.ranked.length, 'ranked protocols'],
      [data.watchlist_count, 'on the watchlist'],
      [data.below_floor_count, 'below the floor'],
    ];
    for (const [value, label] of stats) {
      const stat = element('div', 'hero-stat');
      stat.append(element('strong', '', value), element('span', '', label));
      byId('hero-stats').append(stat);
    }
    const benchmark = `${data.scale.growth_scale.toFixed(4).replace(/\.?0+$/, '')}%`;
    const factors = [
      ['TVL · starting point', 'Each dollar of snapshot TVL contributes one dollar before adjustments. This is a modeling convention.'],
      ['Seven-day TVL momentum', `Divide signed 7-day TVL change by ${benchmark}, the 90th percentile of absolute reported moves among ranked rows. Limit that ratio to −1 through +1, multiply by 0.25 and add 1. Unreported changes use 1×.`],
      ['Time tracked', `Use days between first listing and the snapshot. Subtract ${data.scale.tenure_scale} days, the ranked cohort’s median, and divide by their sum. Multiply by 0.25 and add 1. An unknown date uses 1×.`],
      ['Whole-dollar value', 'Multiply TVL by both adjustments and round to the nearest dollar, with a one-dollar floor. Equal values are ordered by TVL, then slug.'],
    ];
    for (const [title, text] of factors) {
      byId('method-factors').append(element('dt', '', title), element('dd', '', text));
    }
    byId('method-coverage').textContent = `The snapshot screens ${data.protocol_count} protocols. The radar includes ${data.watchlist_count} watchlist protocols and the ${data.below_floor_count} highest-TVL eligible protocols under ${money(data.floor_usd)}. The trading reference contains ${data.trading.length} records.`;
    byId('method-source').textContent = `Source · ${data.source}`;
    drawChart();
  }

  function headerCell(tr, label, classes = '', sortable) {
    const th = element('th', classes);
    th.scope = 'col';
    if (sortable) {
      const labelWithArrow = sortable === order ? `${label} ${direction === 'asc' ? '↑' : '↓'}` : label;
      const button = element('button', '', labelWithArrow);
      button.type = 'button';
      button.dataset.sort = sortable;
      th.append(button);
      if (sortable === order) th.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending');
    } else {
      th.textContent = label;
    }
    tr.append(th);
  }

  function renderHeader() {
    const tr = element('tr');
    if (mode === 'board') headerCell(tr, 'Rank', 'rank');
    headerCell(tr, 'Protocol', 'protocol', mode === 'trading' ? 'name' : undefined);
    headerCell(tr, 'Category');
    headerCell(tr, 'Networks');
    headerCell(tr, labels.tvl_usd, 'number', 'tvl_usd');
    headerCell(tr, labels.change_7d, 'number', 'change_7d');
    headerCell(tr, labels.tenure_days, 'number', 'tenure_days');
    const valueKey = mode === 'trading' ? 'mcap_usd' : 'implied_value_usd';
    headerCell(tr, labels[valueKey], 'number', valueKey);
    if (mode === 'board') {
      headerCell(tr, '');
      tr.lastChild.setAttribute('aria-label', 'Open protocol');
    }
    byId('table-head').replaceChildren(tr);
  }

  function renderedRow(row) {
    const tr = element('tr');
    const rated = mode === 'board';
    if (rated) tr.append(element('td', 'rank', String(row.rank).padStart(2, '0')));
    const nameCell = element('td', 'protocol');
    const name = rated ? link(detailHash(row.slug), '', row.name) : element('strong', '', row.name);
    nameCell.append(name);
    if (rated && row.watchlist) nameCell.append(document.createTextNode(' '), element('span', 'group', 'Watchlist'));
    if (!rated && row.symbol) nameCell.append(document.createTextNode(' '), element('span', 'group', row.symbol));
    const networks = element('td', 'chain-cell', row.chains[0] ?? 'Unreported');
    networks.title = row.chains.join(', ');
    if (row.chains.length > 1) networks.append(element('small', '', `+${row.chains.length - 1}`));
    const tvl = element('td', 'number', money(row.tvl_usd));
    tvl.title = full.format(row.tvl_usd);
    const value = rated ? row.implied_value_usd : row.mcap_usd;
    const estimate = element('td', rated ? 'number value' : 'number', money(value));
    if (value !== null) estimate.title = full.format(value);
    tr.append(nameCell, element('td', 'chain-cell', categoryName(row)), networks, tvl,
      element('td', `number ${movement(row.change_7d)}`, change(row.change_7d)),
      element('td', 'number', tenure(row.tenure_days)), estimate);
    if (rated) {
      const action = element('td', 'number');
      const arrow = link(detailHash(row.slug), 'go', '↗');
      arrow.tabIndex = -1;
      arrow.setAttribute('aria-label', `Open ${row.name}`);
      action.append(arrow);
      tr.append(action);
    }
    return tr;
  }

  function sortRows(a, b) {
    const left = a[order];
    const right = b[order];
    if (left === null) return right === null ? a.slug.localeCompare(b.slug) : 1;
    if (right === null) return -1;
    const diff = typeof left === 'string' ? left.localeCompare(right) : left - right;
    return diff * (direction === 'desc' ? -1 : 1) || (a.rank ?? 0) - (b.rank ?? 0) || a.slug.localeCompare(b.slug);
  }

  function renderTable() {
    const q = query.value.trim().toLowerCase();
    const filtered = tableRows.filter((row) =>
      (!category.value || categoryName(row) === category.value)
      && (!chain.value || row.chains.includes(chain.value))
      && (!q || [row.name, row.slug, row.symbol].some((value) => value?.toLowerCase().includes(q)))
    ).sort(sortRows);
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(page, pages);
    const from = (page - 1) * pageSize;
    renderHeader();
    byId('table-body').replaceChildren(...filtered.slice(from, from + pageSize).map(renderedRow));
    byId('result-count').textContent = `${filtered.length} of ${tableRows.length} protocols`;
    const filters = [category.value, chain.value, query.value.trim()].filter(Boolean);
    byId('active-filters').textContent = filters.length ? filters.join(' · ') : '';
    byId('empty').hidden = filtered.length !== 0;
    byId('pager').hidden = filtered.length === 0;
    byId('page-count').textContent = `${from + 1}–${Math.min(from + pageSize, filtered.length)} shown · Page ${page} of ${pages}`;
    byId('prev').disabled = page === 1;
    byId('next').disabled = page >= pages;
  }

  function planStep(rawStep, index) {
    const li = element('li');
    const body = element('div');
    const header = element('div', 'step-title');
    const separator = rawStep.indexOf('. ');
    const [name, budget] = rawStep.slice(0, separator).split(' · ');
    header.append(element('span', '', name), element('small', '', budget));
    body.append(header, element('p', '', rawStep.slice(separator + 2)));
    li.append(element('span', 'step-n', index + 1), body);
    return li;
  }

  function renderDetail(row) {
    const back = link(lastBoardHash, 'back', '← Back to ranked protocols');
    const hero = element('section', 'detail-hero');
    const intro = element('div');
    const title = element('h1', '', row.name);
    title.id = 'detail-title';
    title.tabIndex = -1;
    intro.append(element('div', 'label', `RANK ${row.rank} / ${data.ranked.length}  ·  ${row.watchlist ? 'WATCHLIST' : 'BELOW FLOOR'}`),
      title, element('p', '', `${categoryName(row)} · No token recorded in the snapshot`));
    const estimate = element('div', 'detail-value');
    estimate.append(element('span', 'label', 'IMPLIED LAUNCH VALUE'), element('strong', '', full.format(row.implied_value_usd)),
      element('small', '', `${row.momentum.toFixed(3)}× momentum  ·  ${row.maturity.toFixed(3)}× tenure`));
    hero.append(intro, estimate);

    const grid = element('div', 'detail-grid');
    const plan = element('section', 'panel');
    const list = element('ol', 'plan');
    list.append(...row.farm_steps.map(planStep));
    plan.append(element('h2', '', 'Farm plan'), element('p', 'intro', 'Start with the $0 checks. Live transaction fees and eligibility depend on the product.'), list);

    const facts = element('aside', 'panel');
    const metrics = element('dl', 'facts');
    const figures = [
      ['Total value locked', full.format(row.tvl_usd), ''],
      ['7-day TVL change', change(row.change_7d), movement(row.change_7d)],
      ['Tracking tenure', row.tenure_days === null ? 'Unknown' : `${countFormat.format(row.tenure_days)} days`, ''],
      ['First tracked', row.listed_at === null ? 'Unknown' : date(row.listed_at), ''],
      ['Category', categoryName(row), ''],
    ];
    for (const [label, value, style] of figures) metrics.append(element('dt', '', label), element('dd', style, value));
    const chains = element('div', 'chips');
    chains.append(...(row.chains.length ? row.chains : ['Unreported']).map((network) => element('span', '', network)));
    const model = link('#method', 'secondary', 'Read the value model ↗');
    facts.append(element('h2', '', 'Snapshot figures'), metrics, element('div', 'chains-title', 'Tracked networks'), chains,
      element('p', 'note', 'Tracking tenure starts on the first date in DefiLlama’s record.'), element('p', 'note'));
    facts.lastChild.append(model);

    grid.append(plan, facts);
    detail.replaceChildren(back, hero, grid);
  }

  function updateView() {
    const [path, search = ''] = location.hash.slice(1).split('?', 2);
    let protocol;
    if (path.startsWith('protocol/')) {
      try {
        protocol = allRanked.get(decodeURIComponent(path.slice('protocol/'.length)));
      } catch {
        // An invalid route falls back to the board.
      }
    }
    const showMethod = path === 'method';
    const showBoard = !protocol && !showMethod;
    board.hidden = !showBoard;
    detail.hidden = !protocol;
    method.hidden = !showMethod;
    const trading = path === 'trading';
    setActiveTab(trading);
    if (protocol) {
      renderDetail(protocol);
      byId('detail-title').focus({ preventScroll: true });
    } else if (showMethod) {
      method.querySelector('.back').href = lastBoardHash;
      byId('method-title').focus({ preventScroll: true });
    } else {
      mode = trading ? 'trading' : 'board';
      configureFilters(mode);
      loadControls(new URLSearchParams(search));
      byId('hero').hidden = trading;
      byId('results-title').textContent = trading ? 'Already-trading reference' : 'Ranked protocols';
      byId('results-caption').textContent = trading
        ? 'Protocols with a CoinGecko ID, symbol or market cap in the snapshot. Listed by name by default.'
        : 'Sealed DefiLlama snapshot. Values reflect a modeled launch scenario.';
      renderTable();
      keepBoardHash();
    }
    window.scrollTo(0, 0);
  }

  function changeControls() {
    page = 1;
    renderTable();
    keepBoardHash();
  }

  byId('filters').addEventListener('submit', (event) => event.preventDefault());
  query.addEventListener('input', changeControls);
  category.addEventListener('change', changeControls);
  chain.addEventListener('change', changeControls);
  sort.addEventListener('change', () => {
    order = sort.value;
    direction = order === 'name' ? 'asc' : 'desc';
    changeControls();
  });
  byId('table-head').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-sort]');
    if (!button) return;
    const key = button.dataset.sort;
    direction = key === order ? (direction === 'asc' ? 'desc' : 'asc') : key === 'name' ? 'asc' : 'desc';
    order = key;
    sort.value = key;
    changeControls();
    byId('table-head').querySelector(`button[data-sort="${key}"]`).focus({ preventScroll: true });
  });
  byId('reset').addEventListener('click', () => {
    loadControls(new URLSearchParams());
    changeControls();
    query.focus();
  });
  for (const [id, delta] of [['prev', -1], ['next', 1]]) {
    byId(id).addEventListener('click', () => {
      page += delta;
      renderTable();
      keepBoardHash();
    });
  }
  window.addEventListener('hashchange', updateView);

  populateSummary();
  updateView();
})();
