import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';

export default {
    input: 'src/frigate-events-card.ts',
    output: {
        file: 'frigate-events-card.js',
        format: 'es',
        sourcemap: false,
    },
    plugins: [
        resolve(),
        typescript(),
        terser({
            format: {
                comments: false,
            },
        }),
    ],
};
