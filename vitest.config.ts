import { defineConfig } from 'vitest/config';

/**
 * Отдельный конфиг для тестов: vite.config.ts задаёт root=src/web (фронт Mini App), из-за чего vitest
 * искал бы тесты там. Здесь возвращаем корень проекта и берём юниты из test/.
 */
export default defineConfig({
  root: '.',
  test: {
    include: ['test/**/*.test.ts'],
  },
});
