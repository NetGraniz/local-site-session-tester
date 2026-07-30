'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'renderer.js'), 'utf8');

const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const uniqueIds = new Set(htmlIds);
assert.equal(uniqueIds.size, htmlIds.length, 'В HTML обнаружены повторяющиеся id.');

const queriedIds = [...renderer.matchAll(/querySelector\('#([^']+)'\)/g)].map((match) => match[1]);
const missingIds = [...new Set(queriedIds.filter((id) => !uniqueIds.has(id)))];
assert.deepEqual(missingIds, [], `Renderer обращается к отсутствующим id: ${missingIds.join(', ')}`);

for (const requiredText of [
  'Повторять завершённые сессии',
  'Задержка перезапуска, мс',
  'Количество циклов',
  'Циклов с ошибкой',
  'Циклов в минуту',
  'Тест будет выполняться до ручной остановки.',
  'Идентификатор запуска'
]) {
  assert.equal(html.includes(requiredText), true, `В интерфейсе отсутствует текст: ${requiredText}`);
}

console.log('UI_CONTRACT_SELF_TEST_OK');
