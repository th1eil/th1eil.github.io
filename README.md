# Rei's Blog

基于 [Zola](https://www.getzola.org/) 构建的个人技术博客，部署在 GitHub Pages。

## 技术栈

- **静态站点生成器**：Zola (Rust)
- **样式**：SCSS（编译为 CSS）
- **代码高亮**：Prism.js（CDN 按需加载）
- **部署**：GitHub Actions → GitHub Pages
- **字体**：系统原生字体栈（无需外部加载）

## 本地开发

```bash
# 安装 Zola (macOS)
brew install zola

# 启动开发服务器（热重载）
zola serve

# 构建生产版本
zola build
```

## 项目结构

```
├── config.toml          # Zola 配置
├── content/             # Markdown 内容
│   ├── _index.md        # 首页（带分页）
│   ├── about.md         # 关于页
│   └── blog/            # 博客文章
├── sass/                # SCSS 样式源文件
│   └── style.scss
├── static/              # 静态资源（图片等）
│   └── pics/
├── templates/           # Tera 模板
│   ├── base.html        # 基础布局
│   ├── index.html       # 首页
│   ├── blog.html        # 博客列表
│   ├── blog-page.html   # 文章详情（含 TOC）
│   ├── about.html       # 关于页
│   └── taxonomy_*.html  # 标签页
└── .github/workflows/   # CI/CD
    └── deploy.yml
```

## License

MIT
