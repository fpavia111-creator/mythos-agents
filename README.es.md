# Mythos Machine domain agents

> Esta traducción la hizo Claude y todavía no la han revisado hablantes nativos. Si hay diferencias, prevalece la [README en inglés](README.md).

Treinta agentes MCP pequeños. Cada uno se encarga de **un solo proceso de negocio** (una revisión de accesos, una conciliación bancaria, una comprobación de migración de ERP, una disputa de reembolso) y no puede actuar fuera de él. Leen los archivos que usted ya exporta, escriben informes en su equipo y esperan a una persona identificada por su nombre antes de cualquier paso importante.

Licencia MIT · Node 20 o posterior · solo archivos locales · sin credenciales · sin dependencias

## Pruébelo

```bash
npx -y ladon-of-access demo        # revisión de accesos con datos ficticios
npx -y olympus-of-migration demo   # preparación de una migración de ERP con datos ficticios
```

Cada agente tiene una `demo` que funciona con archivos ficticios y un servidor MCP (`npx -y <agent> mcp`) para Claude Desktop, Claude Code, Cursor y otros hosts MCP. Las herramientas de cada agente están en su README (en inglés).

## Los agentes

**Finanzas y contabilidad**

| Agente | Qué hace | Espera a una persona antes de |
|---|---|---|
| `olympus-of-migration` | Compara las exportaciones del sistema antiguo y del nuevo (registros que faltan, totales, balances de comprobación por filial y moneda, reglas de campos) y redacta un informe de preparación | aprobar la puesta en producción (nunca lo hace) |
| `penelope-of-recon` | Conciliación de banco y libro mayor desde CSV, Excel, CAMT.053, MT940, BAI2 u OFX: emparejamientos propuestos, partidas en conciliación, cuadre de saldos, arrastre de fin de mes | registrar un asiento de ajuste |
| `ananke-of-match` | Conciliación a tres bandas de pedidos, recepciones y facturas de proveedores, con una lista de excepciones | contabilizar o pagar (nunca) |
| `praxidike-of-expenses` | Notas de gastos y textos de recibos revisados según su política escrita, con hallazgos citados | reembolsar; pagar está bloqueado |
| `auxo-of-vendors` | Preparación de formularios W-9 de proveedores de EE. UU., números fiscales enmascarados, proveedores duplicados y borradores de solicitud | enviar una solicitud; nunca presenta nada ante el IRS |
| `hesperides-of-inventory` | Diferencias de inventario cíclico con controles de fecha, unidad de medida y reconteo, ordenadas por valor | registrar ajustes |
| `urania-of-flux` | Paquete para el consejo a partir de cifras cerradas, con comentarios citados y revisión de afirmaciones | la aprobación y la distribución |
| `polyhymnia-of-grants` | Plazos, ritmo de gasto, resultados y evidencias de subvenciones en un borrador de informe | la presentación |

**Accesos, seguridad y TI**

| Agente | Qué hace | Espera a una persona antes de |
|---|---|---|
| `ladon-of-access` | Recertificación de accesos de personas, agentes y cuentas de servicio: bajas, cuentas inactivas y privilegiadas, conflictos de segregación de funciones, revisores, plazos, paquete de evidencias | retirar un acceso (nunca lo hace) |
| `helios-of-seats` | Licencias SaaS sin uso, inactivas, duplicadas o de plan excesivo, con ahorro estimado y calendario de renovaciones | retirar una licencia |
| `eos-of-onboarding` | Listas de incorporación para empleados, contratistas y clientes, con borradores de solicitudes de acceso | conceder o retirar accesos |
| `tiresias-of-drift` | Desviaciones de configuración y de esquema a lo largo del tiempo, explicadas con niveles de riesgo | aplicar un arreglo en producción |
| `aegle-of-certificates` | Seguimiento de vencimientos de certificados TLS, dominios, licencias y certificados de seguro de proveedores, con borradores de recordatorio | las renovaciones de pago, los cambios en producción y los envíos |
| `aeolus-of-mail` | Auditoría de SPF, DKIM, DMARC, MX, MTA-STS y TLS-RPT con consultas DNS-over-HTTPS de solo lectura | cambiar el DNS (nunca lo hace) |
| `nemesis-of-servers` | Revisión estática de un servidor MCP o Code Mode, o de una configuración MCP, en busca de patrones de riesgo | ejecutarlo (nunca) |

**Clientes, proveedores y operaciones**

| Agente | Qué hace | Espera a una persona antes de |
|---|---|---|
| `soteria-of-refunds` | Clasificación de reembolsos y contracargos según su política, con borradores de paquetes de evidencias | mover dinero (nunca) |
| `augeas-of-masters` | Proveedores y artículos duplicados, vista previa de cada fusión campo por campo, una fusión aprobada cada vez sobre una copia | cada fusión; pagar a un proveedor requiere un clic |
| `nausicaa-of-hygiene` | Limpieza de listas de contactos: rebotes, direcciones genéricas, duplicados, registros antiguos, consentimiento | los borrados masivos |
| `eucleia-of-outreach` | Control de borradores de prospección: lista de exclusión, datos del pie, franja de envío, longitud | enviar (nunca) |
| `epeius-of-rfis` | Registros de RFI y de aprobaciones de obra comparados con su índice de planos y especificaciones, con borradores de RFI que citan sus documentos | el envío |
| `arethusa-of-flows` | Auditoría de flujos de n8n, Zapier y Make rotos o de riesgo | activar o cambiar flujos en producción |

**Privacidad, web y legal**

| Agente | Qué hace | Espera a una persona antes de |
|---|---|---|
| `macaria-of-erasure` | Solicitudes de supresión: dónde están los datos personales y una lista de comprobación | borrar (nunca borra por sí mismo) |
| `britomartis-of-consent` | Inventario de cookies y servicios de terceros a partir de HTML exportado y capturas HAR, comparado con su política y su banner | publicar; no es un gestor de consentimiento ni afirma cumplir el RGPD o la CCPA |
| `daphne-of-pages` | Enlaces rotos, SEO básico y comprobaciones WCAG automatizables sobre HTML exportado, con una lista de arreglos | publicar; no es una opinión legal |
| `solon-of-clauses` | Cláusulas de contratos revisadas según su propio manual, con citas y una lista de cuestiones para sus abogados | un envío vinculante; la firma electrónica está bloqueada; no es asesoramiento legal |
| `lycurgus-of-licenses` | Su política escrita de licencias aplicada a las dependencias npm, con informe, SBOM CycloneDX y SARIF | una publicación de versión; no es asesoramiento legal |
| `eirene-of-controls` | Carpeta de evidencias a partir de los registros de auditoría de los agentes; evidencias, no una certificación | enviarla a un auditor |

**Crear y probar agentes**

| Agente | Qué hace | Espera a una persona antes de |
|---|---|---|
| `mythos-agent-core` | El motor común: manifiesto, política permitir/preguntar/bloquear, validación de entradas, modos Review/Assist/Auto, límites, parada de emergencia, registro de auditoría firmado, página de aprobaciones, memoria del dominio, lectores de archivos, servidor MCP | (las reglas de abajo) |
| `agon-of-evals` | Evaluaciones privadas de un proceso con un modelo fijo, con comparación de regresiones; no llama a ningún modelo | publicar resultados |
| `echo-of-docs` | Desviaciones de la documentación: README y SKILL.md comparados con la lista de herramientas, los esquemas y el package.json, con arreglos mecánicos como copias | publicar la documentación |
| `epimetheus-of-scripts` | Inventario de SuiteScripts de NetSuite y clasificación del riesgo de migrar a 2.1 | desplegar (nunca) |

## Archivos e idiomas

Los agentes leen CSV, TSV, texto separado por punto y coma o barra vertical, Excel `.xlsx`, JSON y JSONL. Doce de ellos reconocen 39 exportaciones con nombre por sus columnas (Okta, Microsoft Entra ID, Google Workspace, NetSuite, QuickBooks Online, Xero, Stripe, Shopify, Salesforce, Ramp, cinco bancos de EE. UU. y otras). Dos de esos formatos se cotejaron con la documentación del fabricante; los demás se escribieron a partir del conocimiento de esas exportaciones, y ninguno se ha probado con una cuenta real.

Los archivos de sistemas de España y de Latinoamérica se leen tal como salen: nombres de columna en español (`Importe`, `Proveedor`, `NIF`, `RFC`, `Concepto`, `Cargo`, `Abono`, `Fecha de vencimiento` y otros), archivos en Windows-1252 o UTF-16, importes como `1.234,56 €` o `$1,234.56`, fechas como `14/11/2026`, `14/NOV/2026` o `14 de noviembre de 2026`, y razones sociales con S.L., S.L.U., S.A. o S.A. de C.V. Con `--lang es`, la página de aprobaciones, el informe de preparación de Olympus y el resumen de recertificación y la página de evidencias de Ladon aparecen en español; los resultados, los códigos y los archivos CSV siguen en inglés.

## Las reglas que sigue cada agente

- Las herramientas desconocidas se bloquean. La decisión por defecto es bloquear.
- **Auto** está desactivado por defecto y se activa acción por acción, con límites de pasos y de gasto y una parada de emergencia.
- La puesta en producción, la retirada de accesos, el borrado de datos personales, el movimiento de dinero, los envíos jurídicamente vinculantes y los despliegues en producción siempre necesitan el clic de una persona identificada por su nombre, incluso en Auto. Lo mismo vale para cambiar lo que recuerda un agente.
- Los agentes con memoria (Olympus y Ladon) solo usan hechos que una persona identificada aceptó, dicen qué hechos usó cada resultado y no pueden aprender nada que relaje un control.
- Cada decisión queda en un registro de auditoría JSONL encadenado por hash, firmado si usted proporciona una clave.
- El texto de sus archivos se trata como datos. Las fórmulas de hoja de cálculo, el HTML sin procesar y los `../` en los identificadores se neutralizan al salir, y un resultado que cite un texto dirigido a un modelo de IA («ignore previous instructions») se marca. La marca es una heurística, no un filtro.

## Lo que no son

- No son integraciones en vivo: leen archivos exportados y nunca inician sesión en sus sistemas.
- No son asesoramiento legal, fiscal, contable ni de auditoría, ni certifican nada.
- No son totalmente autónomos: los pasos de arriba esperan a una persona, siempre.
- No afirman nada sobre las leyes, las normas fiscales ni los formatos de declaración de ningún país.

## Desarrollo

```bash
npm install
npm test
npm run hostile
npm run release:check
npm run bench
```

Crear un agente nuevo: [docs/build-an-agent.md](docs/build-an-agent.md) (en inglés). Los cambios de la 0.2.0: [UPGRADE-0.2.0.md](UPGRADE-0.2.0.md) (en inglés).

MIT © 2026 Kurt Francisco · <https://mythosmachines.com>
