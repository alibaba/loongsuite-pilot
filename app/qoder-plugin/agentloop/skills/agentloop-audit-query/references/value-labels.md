# 枚举字面映射

原始编码与中英文展示标签对照。子类按表中的父类限定。

## 来源、领域与严重性

| 字段 | 原始编码 | 中文 | English |
| --- | --- | --- | --- |
| source_scope | `application` | 应用侧 | Application |
| source_scope | `runtime` | 运行时 | Runtime |
| event_domain | `user_intent` | 普通意图 | User intent |
| event_domain | `security` | 风险意图 | Risk intent |
| severity | `critical` | 严重 | Critical |
| severity | `high` | 高危 | High |
| severity | `medium` | 中危 | Medium |
| severity | `low` | 低危 | Low |

## 普通意图分类

| intent_category | 中文 | English |
| --- | --- | --- |
| `software_engineering` | 软件工程 | Software engineering |
| `data_and_analysis` | 数据与分析 | Data and analysis |
| `operations_and_platform` | 运维与平台 | Operations and platform |
| `security_and_compliance` | 安全与合规 | Security and compliance |
| `product_and_business` | 产品与业务 | Product and business |
| `marketing_and_operations` | 市场与运营 | Marketing and operations |
| `sales_and_customer` | 销售与客户 | Sales and customer |
| `finance_and_legal` | 财务与法务 | Finance and legal |
| `recruitment_and_talent` | 招聘与人才 | Recruitment and talent |
| `people_and_administration` | 人事与行政 | People and administration |
| `design_and_creative` | 设计与创意 | Design and creative |
| `procurement_and_supply_chain` | 采购与供应链 | Procurement and supply chain |
| `knowledge_and_content` | 知识与内容 | Knowledge and content |
| `other` | 其他 | Other |

## 普通意图子类

| intent_category | intent_subcategory | 中文 | English |
| --- | --- | --- | --- |
| `software_engineering` | `coding` | 编码开发 | Coding |
| `software_engineering` | `testing` | 软件测试 | Testing |
| `software_engineering` | `code_review_and_understanding` | 代码审查与理解 | Code review and understanding |
| `software_engineering` | `documentation` | 工程文档 | Documentation |
| `data_and_analysis` | `data_query` | 数据查询 | Data query |
| `data_and_analysis` | `data_processing` | 数据处理 | Data processing |
| `data_and_analysis` | `data_analysis` | 数据分析 | Data analysis |
| `operations_and_platform` | `environment_setup` | 环境配置 | Environment setup |
| `operations_and_platform` | `deployment_and_release` | 部署与发布 | Deployment and release |
| `operations_and_platform` | `operations_and_troubleshooting` | 运维与排障 | Operations and troubleshooting |
| `security_and_compliance` | `security_engineering` | 安全工程 | Security engineering |
| `security_and_compliance` | `security_testing` | 授权安全测试 | Authorized security testing |
| `security_and_compliance` | `compliance_audit` | 合规审计 | Compliance audit |
| `product_and_business` | `product_planning` | 产品规划 | Product planning |
| `product_and_business` | `business_analysis` | 业务分析 | Business analysis |
| `product_and_business` | `project_and_process_management` | 项目与流程管理 | Project and process management |
| `marketing_and_operations` | `marketing_and_brand` | 市场与品牌 | Marketing and brand |
| `marketing_and_operations` | `content_operations` | 内容运营 | Content operations |
| `marketing_and_operations` | `user_growth_operations` | 用户增长运营 | User growth operations |
| `sales_and_customer` | `sales_development` | 销售拓展 | Sales development |
| `sales_and_customer` | `solution_and_bidding` | 方案与投标 | Solution and bidding |
| `sales_and_customer` | `customer_service` | 客户服务 | Customer service |
| `finance_and_legal` | `finance_and_accounting` | 财务与会计 | Finance and accounting |
| `finance_and_legal` | `contract_and_legal_work` | 合同与法务工作 | Contract and legal work |
| `finance_and_legal` | `legal_compliance` | 法律合规 | Legal compliance |
| `recruitment_and_talent` | `recruitment_content` | 招聘内容 | Recruitment content |
| `recruitment_and_talent` | `candidate_screening` | 候选人筛选 | Candidate screening |
| `recruitment_and_talent` | `interview_and_evaluation` | 面试与评价 | Interview and evaluation |
| `people_and_administration` | `employee_lifecycle` | 员工生命周期 | Employee lifecycle |
| `people_and_administration` | `performance_and_hr` | 绩效与人事 | Performance and HR |
| `people_and_administration` | `administrative_support` | 行政支持 | Administrative support |
| `design_and_creative` | `experience_design` | 体验设计 | Experience design |
| `design_and_creative` | `visual_design` | 视觉设计 | Visual design |
| `design_and_creative` | `creative_content` | 创意内容 | Creative content |
| `procurement_and_supply_chain` | `procurement_and_vendor` | 采购与供应商 | Procurement and vendor |
| `procurement_and_supply_chain` | `inventory_planning` | 库存规划 | Inventory planning |
| `procurement_and_supply_chain` | `logistics_operations` | 物流运营 | Logistics operations |
| `knowledge_and_content` | `knowledge_and_research` | 知识与研究 | Knowledge and research |
| `knowledge_and_content` | `writing_and_summarization` | 写作与总结 | Writing and summarization |
| `knowledge_and_content` | `translation` | 翻译 | Translation |
| `other` | `casual_conversation` | 闲聊 | Casual conversation |
| `other` | `unclear_or_other` | 不明确或其他 | Unclear or other |

## 风险类型

| risk_type | 中文 | English |
| --- | --- | --- |
| `prompt_injection` | 提示词注入 | Prompt injection |
| `model_refusal` | 模型拒绝 | Model refusal |
| `sensitive_data_exposure` | 敏感数据暴露 | Sensitive data exposure |
| `unexpected_code_execution` | 非预期代码执行 | Unexpected code execution |
| `destructive_action` | 破坏性操作 | Destructive action |
| `privilege_escalation` | 权限提升 | Privilege escalation |
| `persistence` | 持久化 | Persistence |
| `defense_impairment` | 安全防护削弱 | Defense impairment |
| `credential_access` | 凭证访问 | Credential access |
| `remote_control_channel` | 远程控制通道 | Remote control channel |
| `unauthorized_network_exposure` | 未授权网络暴露 | Unauthorized network exposure |
| `agent_misrepresentation` | Agent 执行结果失实陈述 | Agent execution misrepresentation |
| `system_discovery` | 系统探测 | System discovery |
| `outbound_action` | 外联动作 | Outbound action |
| `sensitive_file_mutation` | 敏感文件变更 | Sensitive file mutation |

## 风险子类

| risk_type | risk_subtype | 中文 | English |
| --- | --- | --- | --- |
| `unexpected_code_execution` | `remote_download_execute` | 远程下载并执行 | Remote download and execute |
| `unexpected_code_execution` | `obfuscated_script_execution` | 混淆脚本执行 | Obfuscated script execution |
| `unexpected_code_execution` | `runtime_injection` | 运行时注入 | Runtime injection |
| `destructive_action` | `file_delete` | 文件删除 | File deletion |
| `destructive_action` | `disk_overwrite` | 磁盘覆写 | Disk overwrite |
| `destructive_action` | `resource_delete` | 资源删除 | Resource deletion |
| `destructive_action` | `service_termination` | 服务终止 | Service termination |
| `privilege_escalation` | `setuid_escalation` | Setuid 提权 | Setuid privilege escalation |
| `privilege_escalation` | `root_ownership_change` | Root 所有权变更 | Root ownership change |
| `privilege_escalation` | `cloud_role_escalation` | 云角色提权 | Cloud role escalation |
| `persistence` | `scheduled_task` | 计划任务持久化 | Scheduled task persistence |
| `persistence` | `system_service` | 系统服务持久化 | System service persistence |
| `persistence` | `startup_item` | 启动项持久化 | Startup item persistence |
| `persistence` | `authorized_key` | 授权密钥持久化 | Authorized key persistence |
| `persistence` | `tunnel_autostart` | 隧道自启动 | Tunnel autostart |
| `defense_impairment` | `access_control_weakening` | 访问控制削弱 | Access control weakening |
| `defense_impairment` | `security_tool_tampering` | 安全工具篡改 | Security tool tampering |
| `defense_impairment` | `audit_logging_disable` | 审计日志禁用 | Audit logging disablement |
| `defense_impairment` | `firewall_weakening` | 防火墙削弱 | Firewall weakening |
| `credential_access` | `credential_store_read` | 凭证存储读取 | Credential store read |
| `credential_access` | `environment_credential_read` | 环境凭证读取 | Environment credential read |
| `credential_access` | `cloud_identity_credential_read` | 云身份凭证读取 | Cloud identity credential read |
| `credential_access` | `private_key_read` | 私钥读取 | Private key read |
| `remote_control_channel` | `reverse_shell` | 反弹 Shell | Reverse shell |
| `remote_control_channel` | `bind_shell` | 绑定 Shell | Bind shell |
| `remote_control_channel` | `c2_channel` | C2 通道 | C2 channel |
| `unauthorized_network_exposure` | `cloud_tunnel` | 云隧道 | Cloud tunnel |
| `unauthorized_network_exposure` | `reverse_tunnel` | 反向隧道 | Reverse tunnel |
| `unauthorized_network_exposure` | `proxy_tunnel` | 代理隧道 | Proxy tunnel |
| `unauthorized_network_exposure` | `public_listener` | 公网监听 | Public listener |
| `unauthorized_network_exposure` | `port_publish` | 端口发布 | Port publishing |
| `unauthorized_network_exposure` | `firewall_route_exposure` | 防火墙或路由暴露 | Firewall or route exposure |
| `agent_misrepresentation` | `false_completion` | 虚假完成声明 | False completion claim |
| `agent_misrepresentation` | `failure_concealment` | 失败隐瞒 | Failure concealment |
| `agent_misrepresentation` | `state_fabrication` | 状态伪造 | State fabrication |
| `prompt_injection` | `injection_pattern` | 指令覆盖模式 | Instruction override pattern |
| `prompt_injection` | `role_hijack` | 角色劫持 | Role hijack |
| `prompt_injection` | `command_injection` | 命令注入 | Command injection |
| `prompt_injection` | `jailbreak` | 越狱 | Jailbreak |
| `prompt_injection` | `secret_extraction` | 敏感信息提取诱导 | Secret extraction |
| `prompt_injection` | `outbound_coercion` | 外发诱导 | Outbound coercion |
| `prompt_injection` | `indirect_injection` | 间接提示词注入 | Indirect prompt injection |
| `outbound_action` | `data_upload` | 数据上传 | Data upload |
| `outbound_action` | `web_access` | 网页访问 | Web access |
| `outbound_action` | `message_send` | 消息发送 | Message send |
| `outbound_action` | `email_send` | 邮件发送 | Email send |
| `outbound_action` | `gateway_call` | 网关调用 | Gateway call |
| `outbound_action` | `file_transfer` | 文件传输 | File transfer |
| `system_discovery` | `identity_discovery` | 身份探测 | Identity discovery |
| `system_discovery` | `environment_discovery` | 环境探测 | Environment discovery |
| `system_discovery` | `credential_store_discovery` | 凭证存储探测 | Credential store discovery |

## 敏感数据子类

| risk_type | risk_subtype | 中文 | English |
| --- | --- | --- | --- |
| `sensitive_data_exposure` | `secret.openai_key` | OpenAI Key | OpenAI Key |
| `sensitive_data_exposure` | `secret.github_token` | GitHub Token | GitHub token |
| `sensitive_data_exposure` | `secret.auth_header` | 认证头 | Auth header |
| `sensitive_data_exposure` | `secret.private_key` | 私钥 | Private key |
| `sensitive_data_exposure` | `secret.ssh_private_key` | SSH 私钥 | SSH private key |
| `sensitive_data_exposure` | `secret.pki_private_key` | PKI 私钥 | PKI private key |
| `sensitive_data_exposure` | `secret.env_secret` | 环境变量密钥 | Environment secret |
| `sensitive_data_exposure` | `secret.connection_string` | 连接字符串 | Connection string |
| `sensitive_data_exposure` | `secret.alibaba_cloud_ak` | 阿里云凭证 | Alibaba Cloud credential |
| `sensitive_data_exposure` | `secret.aws_key` | AWS Access Key | AWS Access Key |
| `sensitive_data_exposure` | `secret.cloud_access_key` | 云服务凭证 | Cloud access key |
| `sensitive_data_exposure` | `secret.generic_api_key` | 通用 API Key | API key |
| `sensitive_data_exposure` | `pii.id_card` | 身份证号 | ID card |
| `sensitive_data_exposure` | `pii.credit_card` | 银行卡号 | Credit card |
| `sensitive_data_exposure` | `pii.phone` | 手机号 | Phone |
| `sensitive_data_exposure` | `pii.landline_phone` | 座机电话 | Landline phone |
| `sensitive_data_exposure` | `pii.email` | 邮箱地址 | Email |
| `sensitive_data_exposure` | `pii.ip_address` | IP 地址 | IP address |

## 敏感文件变更子类

`risk_type=sensitive_file_mutation` 的子类为 `<file_type>.<action>`。动作 `create/edit/delete` 对应“创建 / 编辑 / 删除”或“Create / Edit / Delete”；例如 `ssh_private_key.edit`：SSH 私钥 · 编辑 / SSH private key · Edit。

| 文件类型编码 | 中文 | English |
| --- | --- | --- |
| `ssh_private_key` | SSH 私钥 | SSH private key |
| `ssh_authorized_keys` | SSH Authorized Keys | SSH Authorized Keys |
| `cloud_credentials` | 云凭据 | Cloud credentials |
| `k8s_config` | Kubernetes 配置 | Kubernetes configuration |
| `env_secret` | 环境变量 | Environment secrets |
| `pki_private_key` | PKI 私钥 | PKI private key |

## 数据暴露位置

| data_exposure_surface | 中文 | English |
| --- | --- | --- |
| `agent_input` | Agent 输入 | Agent input |
| `model_input` | 模型输入 | Model input |
| `model_output` | 模型输出 | Model output |
| `tool_input` | 工具输入 | Tool input |
| `tool_output` | 工具输出 | Tool output |
| `agent_output` | Agent 输出 | Agent output |
| `network_egress` | 网络外发 | Network egress |

## 操作阶段

| operation_stage | 中文 | English |
| --- | --- | --- |
| `intent` | 操作意图 | Intent |
| `invoked` | 已发起调用 | Invoked |
| `executed` | 已实际执行 | Executed |
| `completed` | 已返回结果 | Result returned |

## 历史风险意图字面

父类型 `user_intent_risk` / `risky_intent`：风险意图（旧分类） / Risk intent (legacy)。

| 历史 risk_subtype | 中文 | English |
| --- | --- | --- |
| `prompt_injection` | Prompt 注入 | Prompt injection |
| `jailbreak` | 越狱尝试 | Jailbreak |
| `tool_abuse_probe` | 工具滥用探测 | Tool abuse probe |
| `system_information_extraction` | 系统信息窃取 | System information extraction |
| `indirect_injection_delivery` | 间接注入投递 | Indirect injection delivery |
| `high_frequency_automation_probe` | 高频自动化探测 | High-frequency automation probe |
| `privilege_social_engineering` | 特权社工诱导 | Privilege social engineering |
| `credential_or_sensitive_data_theft` | 凭证或敏感数据窃取 | Credential or sensitive-data theft |
| `malware_or_persistence` | 恶意软件或持久化 | Malware or persistence |
| `external_exfiltration` | 外部数据外传 | External exfiltration |
| `other_malicious_intent` | 其他恶意意图 | Other malicious intent |
