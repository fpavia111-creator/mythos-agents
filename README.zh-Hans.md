# Mythos Machine domain agents

> 本译文由 Claude 翻译，尚未经过母语人士审校。如与[英文 README](README.md) 不一致，以英文版为准。

三十个小型 MCP 智能体。每个智能体只负责**一个业务流程**（访问权限复核、银行对账、ERP 迁移检查、退款与拒付处理等），无法在该流程之外执行任何操作。它们读取您已经导出的文件，在您的电脑上生成报告，并在任何重要操作之前等待一位具名人员确认。

MIT 许可证 · Node 20 或更高版本 · 仅使用本地文件 · 无需凭据 · 无第三方依赖

## 试用

```bash
npx -y ladon-of-access demo        # 用虚构数据做访问权限复核
npx -y olympus-of-migration demo   # 用虚构数据做 ERP 迁移就绪检查
```

每个智能体都有一个使用虚构文件的 `demo`，以及一个供 Claude Desktop、Claude Code、Cursor 等 MCP 主机使用的 MCP 服务器（`npx -y <agent> mcp`）。各工具的说明见每个智能体的 README（英文）。

## 智能体一览

**财务与会计**

| 智能体 | 功能 | 需等待人员确认的操作 |
|---|---|---|
| `olympus-of-migration` | 比较旧系统与新系统的导出（缺失记录、合计、按子公司和币种的试算平衡表、字段规则），生成迁移就绪报告 | 批准上线（它从不自行批准） |
| `penelope-of-recon` | 基于 CSV、Excel、CAMT.053、MT940、BAI2 或 OFX 做银行与总账对账：建议匹配、未达项、余额核对、月末结转 | 记录调整分录 |
| `ananke-of-match` | 采购订单、收货与发票的三方匹配及例外清单 | 记账或付款（从不） |
| `praxidike-of-expenses` | 按您的书面制度检查费用报销和收据文本，并给出有依据的结论 | 报销；付款被禁止 |
| `auxo-of-vendors` | 美国 W-9 准备情况、脱敏税号、重复供应商与请求草稿 | 发送请求；从不向 IRS 申报 |
| `hesperides-of-inventory` | 盘点差异的时间、计量单位与复盘检查，按金额排序 | 记录调整 |
| `urania-of-flux` | 基于已锁定数字的董事会材料，附有依据的说明和陈述核查 | 签核与分发 |
| `polyhymnia-of-grants` | 将资助项目的期限、预算进度、成果与证据整理成报告草稿 | 提交 |

**访问、安全与 IT**

| 智能体 | 功能 | 需等待人员确认的操作 |
|---|---|---|
| `ladon-of-access` | 人员、代理和服务账户的访问权限复核：离职人员、闲置与特权账户、职责分离冲突、复核人、期限、证据包 | 撤销权限（它从不自行撤销） |
| `helios-of-seats` | 未使用、闲置、重复及套餐过高的 SaaS 席位，估算节省金额并生成续约日历 | 收回席位 |
| `eos-of-onboarding` | 员工、承包商和客户的入职清单及权限申请草稿 | 授予或撤销权限 |
| `tiresias-of-drift` | 配置与数据结构随时间的变化，并按风险等级说明 | 将修复应用到生产环境 |
| `aegle-of-certificates` | 跟踪 TLS 证书、域名、许可证及供应商保险证明的到期情况，并起草催办信 | 付费续订、生产变更与发送 |
| `aeolus-of-mail` | 通过只读的 DNS-over-HTTPS 查询审查 SPF、DKIM、DMARC、MX、MTA-STS 与 TLS-RPT | 修改 DNS（它从不修改） |
| `nemesis-of-servers` | 静态审查 MCP 或 Code Mode 服务器及 MCP 配置中的风险模式 | 运行它（从不） |

**客户、供应商与运营**

| 智能体 | 功能 | 需等待人员确认的操作 |
|---|---|---|
| `soteria-of-refunds` | 按您的制度对退款与拒付进行分类，并起草证据包 | 资金划转（从不） |
| `augeas-of-masters` | 查找重复的供应商与物料，逐字段预览合并，在副本上每次执行一项已批准的合并 | 每次合并；向供应商付款需一次点击确认 |
| `nausicaa-of-hygiene` | 联系人清单整理：退信、角色邮箱、重复、过期记录、同意状态 | 批量删除 |
| `eucleia-of-outreach` | 检查外联邮件草稿：退订名单、页脚信息、发送时段、长度 | 发送（从不） |
| `epeius-of-rfis` | 将施工 RFI 与报审台账同图纸和规范目录比对，并起草引用您文件的 RFI | 发送 |
| `arethusa-of-flows` | 审查 n8n、Zapier 与 Make 流程中失效或有风险的流程 | 启用或修改生产流程 |

**隐私、网站与法务**

| 智能体 | 功能 | 需等待人员确认的操作 |
|---|---|---|
| `macaria-of-erasure` | 删除请求：个人数据的位置与检查清单 | 删除（它从不自行删除） |
| `britomartis-of-consent` | 从导出的 HTML 与 HAR 记录中盘点 Cookie 和第三方服务，并与您公布的政策和横幅比较 | 发布；它不是同意管理工具，也不声称符合 GDPR 或 CCPA |
| `daphne-of-pages` | 检查导出 HTML 的失效链接、SEO 基础项和可自动检查的 WCAG 项目，并给出修复清单 | 发布；不构成法律意见 |
| `solon-of-clauses` | 按您自己的合同手册检查条款，附条款出处和给律师的问题清单 | 有约束力的发送；电子签名被禁止；不构成法律建议 |
| `lycurgus-of-licenses` | 将您的书面许可证政策应用于 npm 依赖，生成报告、CycloneDX SBOM 与 SARIF | 发布版本；不构成法律建议 |
| `eirene-of-controls` | 基于智能体审计日志生成证据文件夹；只是证据，不是认证 | 发送给审计人员 |

**构建与测试智能体**

| 智能体 | 功能 | 需等待人员确认的操作 |
|---|---|---|
| `mythos-agent-core` | 共享运行时：清单、允许/询问/禁止策略、输入校验、Review/Assist/Auto 模式、上限、紧急停止、签名审计日志、审批页面、领域记忆、文件读取、MCP 服务器 | （见下方规则） |
| `agon-of-evals` | 针对一个流程、一个固定模型的私有评测与回归比较；不调用任何模型 | 发布结果 |
| `echo-of-docs` | 将 README 与 SKILL.md 同工具列表、数据结构和 package.json 比对，机械修复以副本形式给出 | 发布文档 |
| `epimetheus-of-scripts` | NetSuite SuiteScript 清单与 2.1 迁移风险排序 | 部署（从不） |

## 文件与语言

支持 CSV、TSV、分号或竖线分隔的文本、Excel `.xlsx`、JSON 与 JSONL。其中十二个智能体可按列名识别 39 种常见导出（Okta、Microsoft Entra ID、Google Workspace、NetSuite、QuickBooks Online、Xero、Stripe、Shopify、Salesforce、Ramp、多家美国银行等）。其中两种已与厂商文档核对，其余根据对这些导出的了解编写，尚未在真实账户上测试。

中国大陆和台湾系统导出的文件也能直接读取：中文列名（`金额`、`供应商`、`统一社会信用代码`、`借方`、`贷方` 等）、GB18030/GBK、Big5 与 UTF-16 编码、`¥58.00` 或 `1,200元` 这样的金额、`2026年11月14日` 或民国纪年这样的日期，以及带有 `有限公司`、`股份有限公司` 的公司名称。使用 `--lang zh` 时，审批页面、Olympus 迁移就绪报告以及 Ladon 复核摘要和证据页面会以简体中文显示；结果、代码和 CSV 文件保持英文。

## 每个智能体都遵守的规则

- 未知工具一律禁止。默认决定为禁止。
- **Auto** 默认关闭，需按操作逐项开启，并有步数与支出上限和紧急停止。
- 上线、撤销权限、删除个人数据、资金划转、具有法律约束力的发送以及生产部署，即使在 Auto 下也始终需要一位具名人员点击确认。修改智能体的记忆也是如此。
- 有记忆的智能体（Olympus 与 Ladon）只使用具名人员接受过的事实，说明每个结果使用了哪些事实，并且无法学习任何会放松检查的内容。
- 每个决定都会写入哈希链式的 JSONL 审计日志；如提供密钥，还会签名。
- 文件中的文本一律视为数据。电子表格公式、原始 HTML 和 ID 中的 `../` 在输出时会被中和；若结果引用了面向 AI 模型的文字（如 “ignore previous instructions”），会被标记。该标记是一种启发式方法，而不是过滤器。

## 它们不是什么

- 不是实时集成：只读取导出的文件，从不登录您的系统。
- 不构成法律、税务、会计或审计建议，也不对任何事项作出认证。
- 不是完全自主：上述操作每次都会等待人员确认。
- 不对任何国家或地区的法律、税务规则或申报格式作出任何声明。

## 开发

```bash
npm install
npm test
npm run hostile
npm run release:check
npm run bench
```

构建新智能体：[docs/build-an-agent.md](docs/build-an-agent.md)（英文）。0.2.0 的变更：[UPGRADE-0.2.0.md](UPGRADE-0.2.0.md)（英文）。

MIT © 2026 Kurt Francisco · <https://mythosmachines.com>
