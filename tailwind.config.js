/**
 * @type {import('tailwindcss').Config}
 *
 * 配色分三层，改主题时只需要动 index.css 里的变量，不用碰组件：
 *
 *   中性层  slate        —— 底、面板、描边（不 token 化，暗色主题的骨架）
 *   主色层  indigo       —— 所有「可操作 / 已开启」：主按钮、开关、激活态
 *   语义层  rose/emerald —— 只在表达「当前在做什么」时出现：
 *                            rose = 抠除（破坏性），emerald = 恢复（建设性）
 *
 * 语义色的使用规则：**颜色只在表达状态时出现，参数开关永远是主色。**
 * 这条规则比具体的色值重要 —— 遵守它，以后加功能就不会重新变花。
 *
 * 三个色板都走 CSS 变量（index.css 的 :root），值写成 "R G B" 三元组，
 * 配合 <alpha-value> 才能让 bg-indigo-500/15 这类透明度修饰继续生效。
 */
export default {
  content: [
    './index.html',
    './index.tsx',
    './App.tsx',
    './components/**/*.{ts,tsx}',
    './services/**/*.{ts,tsx}',
    './utils/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // 中性层：暖调深灰（warm neutral）。类名仍叫 slate，值换成带暖意的石墨色，
        // 这样全站 253 处 slate-* 自动跟着变，不用逐个改组件。
        slate: {
          50:  'rgb(var(--ink-50) / <alpha-value>)',
          100: 'rgb(var(--ink-100) / <alpha-value>)',
          200: 'rgb(var(--ink-200) / <alpha-value>)',
          300: 'rgb(var(--ink-300) / <alpha-value>)',
          400: 'rgb(var(--ink-400) / <alpha-value>)',
          500: 'rgb(var(--ink-500) / <alpha-value>)',
          600: 'rgb(var(--ink-600) / <alpha-value>)',
          700: 'rgb(var(--ink-700) / <alpha-value>)',
          800: 'rgb(var(--ink-800) / <alpha-value>)',
          900: 'rgb(var(--ink-900) / <alpha-value>)',
          950: 'rgb(var(--ink-950) / <alpha-value>)',
        },
        // 主色（原 indigo）：主按钮、开关、激活态、状态小圆点
        indigo: {
          50:  'rgb(var(--accent-50) / <alpha-value>)',
          100: 'rgb(var(--accent-100) / <alpha-value>)',
          200: 'rgb(var(--accent-200) / <alpha-value>)',
          300: 'rgb(var(--accent-300) / <alpha-value>)',
          400: 'rgb(var(--accent-400) / <alpha-value>)',
          500: 'rgb(var(--accent-500) / <alpha-value>)',
          600: 'rgb(var(--accent-600) / <alpha-value>)',
          700: 'rgb(var(--accent-700) / <alpha-value>)',
          800: 'rgb(var(--accent-800) / <alpha-value>)',
          900: 'rgb(var(--accent-900) / <alpha-value>)',
        },
        // 语义色「抠除 / 破坏性」：只用于模式按钮、画布外框、提示条
        rose: {
          300: 'rgb(var(--danger-300) / <alpha-value>)',
          400: 'rgb(var(--danger-400) / <alpha-value>)',
          500: 'rgb(var(--danger-500) / <alpha-value>)',
          600: 'rgb(var(--danger-600) / <alpha-value>)',
        },
        // 语义色「恢复 / 建设性」
        emerald: {
          300: 'rgb(var(--success-300) / <alpha-value>)',
          400: 'rgb(var(--success-400) / <alpha-value>)',
          500: 'rgb(var(--success-500) / <alpha-value>)',
          600: 'rgb(var(--success-600) / <alpha-value>)',
        },
        // 提示 / 警告：低饱和暖琥珀。和 danger / success 一样只表达状态，
        // 替代原来 Tailwind 默认的亮黄／亮红／亮绿，避免和主色抢注意力。
        warning: {
          300: 'rgb(var(--warning-300) / <alpha-value>)',
          400: 'rgb(var(--warning-400) / <alpha-value>)',
          800: 'rgb(var(--warning-800) / <alpha-value>)',
          900: 'rgb(var(--warning-900) / <alpha-value>)',
        },
        // 画布橙标记的文字描述色，与 canvas 里的 rgba(251,146,60) 对齐
        orange: {
          300: 'rgb(var(--orange-300) / <alpha-value>)',
          400: 'rgb(var(--orange-400) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Archivo', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
