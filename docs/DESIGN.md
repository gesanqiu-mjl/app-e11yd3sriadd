# Theme Name: 可爱极简

# Vibe & Description:
粉彩色系，圆润形状，轻盈留白，带有日系卡哇伊气质的极简风格。整体温柔、清爽、亲近，强调可爱但不杂乱。

# Color

- 使用低饱和度粉彩色，避免深色背景、荧光色和霓虹发光。
- 背景使用暖白色（#FFF7ED）或极浅橙白，主色使用柔粉（#F9A8D4），辅助点缀可使用淡紫（#A78BFA）、浅青（#67E8F9）、淡黄（#FDE68A）。文字使用柔和深灰，保持清晰但不生硬。

# Font

- 使用「资源圆体」作为标题字体。（https://resource-static.bj.bcebos.com/fonts-skill/ResourceHanRoundedCN-Bold.ttf）
- 使用「HarmonyOS Sans」作为正文字体。（https://resource-static.bj.bcebos.com/fonts-skill/HarmonyOSSans_Regular.ttf）

# Animation

- 点击时使用轻微回弹反馈，元素先缩小再恢复，像柔软糖果被按压。
- Hover 或触摸反馈采用 `scale-105`、`active:scale-95`，过渡时长约 200ms，并使用带回弹感的缓动曲线。
- 元素出现时可使用淡入、轻微上浮或小幅摇摆，避免生硬线性动画。

# Layout

- 页面保持宽松留白，信息密度低，整体像柔软的粉彩卡片被轻轻摆放在暖白背景上。
- 卡片、按钮和输入框统一使用大圆角，常用 `rounded-2xl`、`rounded-3xl`、`rounded-full`。
- 移动端触控目标不低于 44px，间距舒适，重点内容通过颜色深浅、字号和留白建立层级。

# Elements

- 按钮使用粉彩纯色或柔和渐变，圆角胶囊形，带轻微缩放反馈。
- 卡片使用白色或暖白背景，搭配柔和阴影 `shadow-sm` / `shadow-md`，可添加浅粉边框 `border-2 border-pink-200`。
- 输入框使用圆润边框和粉彩聚焦外圈，如 `focus:ring-4 focus:ring-pink-100`。
- 避免黑色粗边框、强阴影、小圆角和任何霓虹发光效果。