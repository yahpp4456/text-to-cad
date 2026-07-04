# 第三方授權聲明(THIRD-PARTY NOTICES)

本文件彙整 `apps/cad-chat` 散布時涉及的第三方元件授權。cad-chat 本身隨
text-to-cad 儲存庫以 MIT 授權(見儲存庫根目錄 `LICENSE`,Copyright (c) 2026
earthtojake)。

最後盤點:2026-07-04(版本以當時 `package-lock.json` 為準)。

---

## 前端 bundle 內含(散布產物必列)

### three.js v0.160.0 — MIT

```
The MIT License

Copyright © 2010-2023 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### React / React DOM v18.3.1 — MIT

```
MIT License

Copyright (c) Facebook, Inc. and its affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### gifenc v1.0.3 — MIT

```
The MIT License (MIT)
Copyright (c) 2017 Matt DesLauriers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### packages/cadjs、packages/cadpy(儲存庫內共用程式庫)— MIT

與本儲存庫同授權(根目錄 `LICENSE`),前端 bundle 內含 cadjs 原始碼。

## 伺服端執行期依賴(不進前端 bundle,隨部署散布時列)

### @anthropic-ai/claude-agent-sdk v0.3.195 — Anthropic 專有授權

© Anthropic PBC. All rights reserved. 使用受 Anthropic 法律協議約束:
<https://code.claude.com/docs/en/legal-and-compliance>

**重要**:透過本 SDK 呼叫 Claude 的認證方式有條款界線——訂閱 OAuth token 僅限
訂閱者本人使用;向第三方使用者提供服務必須使用 Claude Console 的 API key
(Commercial Terms)。詳見 README「一次性設定(認證)」。

## 建置工具鏈(產物不含其原始碼,慣例列出)

- **Vite** v7.x — MIT,Copyright (c) 2019-present, VoidZero Inc. and Vite
  contributors(完整聲明含其 vendored 依賴,見 `node_modules/vite/LICENSE.md`)
- **@vitejs/plugin-react** v4.7.0 — MIT,Copyright (c) 2019-present, Yuxi
  (Evan) You and Vite contributors

## Python 幾何管線(隨部署形態納入;非前端散布物)

cad-chat 伺服端呼叫儲存庫的 CAD pipeline(`.venv`),若隨產品一併散布,下列
授權適用:

- **build123d** — Apache-2.0
- **cadquery-ocp(OCP)** — Apache-2.0(OpenCascade 的 Python 綁定)
- **Open CASCADE Technology(OCCT)** — LGPL-2.1 **含 OCCT 例外**
  (動態連結散布即合規;OCP wheel 以共享庫形式載入,需隨附授權文本並保留
  重新連結的可能)
- **numpy** — BSD-3-Clause 等(見其 LICENSE 組合)
- **ezdxf** — MIT

各套件完整授權文本見 `.venv` 內對應的 `*.dist-info` 目錄,或各專案官方
儲存庫。
