import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only test tooling uses this loader. An explicit runtime is trusted executable code.
export async function loadJSDOM({ modulePath = process.env.JSDOM_MODULE_PATH, projectFile = new URL('../package.json', import.meta.url) } = {}) {
  const explicit = modulePath !== undefined && modulePath !== '';
  let runtime;
  try {
    const filename = explicit ? modulePath : createRequire(projectFile).resolve('jsdom');
    const url = filename.startsWith('file:') ? new URL(filename).href : pathToFileURL(resolve(filename)).href;
    const imported = await import(url);
    runtime = imported.JSDOM ?? imported.default?.JSDOM;
    if (typeof runtime !== 'function') throw new Error('Modül JSDOM dışa aktarmıyor.');
  } catch (cause) {
    const message = explicit
      ? 'JSDOM_MODULE_PATH ile belirtilen modül yüklenemedi. Güvendiğiniz mevcut JSDOM kurulumunun giriş dosyasını belirtin; başka kurulum denenmedi.'
      : 'UI testleri için JSDOM bulunamadı. Projedeki mevcut jsdom paketini kullanın veya JSDOM_MODULE_PATH ile güvendiğiniz kurulumun giriş dosyasını belirtin. Otomatik kurulum yapılmadı.';
    throw new Error(message, { cause });
  }
  return runtime;
}
