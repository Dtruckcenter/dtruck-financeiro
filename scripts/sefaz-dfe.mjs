// Robô da Receita: baixa as NF-e emitidas contra o CNPJ da Dtruck (Distribuição DF-e do Ambiente Nacional),
// registra a "Ciência da Operação" para liberar o XML completo e envia tudo para o sistema.
// Roda no GitHub Actions (.github/workflows/sefaz-dfe.yml). Nada aqui imprime o certificado ou a senha.
//
// Variáveis de ambiente:
//   CERT_PFX_BASE64  certificado A1 (.pfx) em base64          (segredo do GitHub)
//   CERT_PASSWORD    senha do certificado                      (segredo do GitHub)
//   DFE_TOKEN        token do robô no sistema                  (segredo do GitHub)
//   API_URL          endereço do sistema, ex.: https://dtruck-financeiro.xxx.workers.dev
//   DTRUCK_CNPJ      CNPJ da Dtruck (só números)
//   DTRUCK_UF        UF da Dtruck (sigla, ex.: RS) — usada como cUFAutor
//   SEFAZ_AMBIENTE   1 = produção (padrão), 2 = homologação
//   SEFAZ_DIST_URL / SEFAZ_EVENTO_URL  (opcional, para testes)

import https from 'node:https';
import zlib from 'node:zlib';
import forge from 'node-forge';
import { SignedXml } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';

const UF = { RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17, MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29, MG: 31, ES: 32, RJ: 33, SP: 35, PR: 41, SC: 42, RS: 43, MS: 50, MT: 51, GO: 52, DF: 53 };
const env = process.env;
const AMB = env.SEFAZ_AMBIENTE === '2' ? '2' : '1';
const DIST_URL = env.SEFAZ_DIST_URL || (AMB === '1'
  ? 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx'
  : 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx');
const EVENTO_URL = env.SEFAZ_EVENTO_URL || (AMB === '1'
  ? 'https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx'
  : 'https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx');
const CNPJ = String(env.DTRUCK_CNPJ || '').replace(/\D/g, '');
const UF_COD = UF[String(env.DTRUCK_UF || '').toUpperCase()] || Number(env.DTRUCK_UF);
const API = String(env.API_URL || '').replace(/\/$/, '');
const MAX_LOOPS = 15;
// CFOPs (3 últimos dígitos) que envolvem pagamento: compras, ativo, uso e consumo, serviços (mesma lista do sistema)
const CFOP_FIN = new Set(['101','102','103','104','105','106','107','108','109','110','111','112','113','114','115','116','117','118','119','120','122','123','124','125','126','128','401','402','403','404','405','406','407','408','551','556','653','933']);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
function falha(msg) { console.error('ERRO: ' + msg); process.exitCode = 1; }

// ---------- Certificado ----------
function lerCertificado() {
  const der = forge.util.decode64(String(env.CERT_PFX_BASE64 || '').replace(/\s+/g, ''));
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, env.CERT_PASSWORD || '');
  const bags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]
    || p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [];
  if (!bags.length) throw new Error('Não encontrei a chave privada dentro do certificado.');
  const key = bags[0].key;
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map(b => b.cert);
  const leaf = certs.find(c => c.publicKey.n && c.publicKey.n.equals(key.n));
  if (!leaf) throw new Error('Não encontrei o certificado correspondente à chave.');
  const chain = [leaf, ...certs.filter(c => c !== leaf)];
  const dias = Math.floor((leaf.validity.notAfter - Date.now()) / 864e5);
  return {
    keyPem: forge.pki.privateKeyToPem(key),
    certPem: forge.pki.certificateToPem(leaf),
    chainPem: chain.map(c => forge.pki.certificateToPem(c)).join(''),
    validade: leaf.validity.notAfter.toISOString().slice(0, 10),
    dias,
  };
}

// ---------- HTTP/SOAP ----------
function post(url, headers, body, tlsOpts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Length': Buffer.byteLength(body), ...headers }, timeout: 90000, ...tlsOpts }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Tempo esgotado em ' + u.hostname)));
    req.on('error', reject);
    req.end(body);
  });
}
const envelope = inner => `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>${inner}</soap12:Body></soap12:Envelope>`;
async function soap(url, action, inner, cert) {
  const r = await post(url, { 'Content-Type': `application/soap+xml; charset=utf-8; action="${action}"` }, envelope(inner), { key: cert.keyPem, cert: cert.chainPem });
  if (r.status >= 500 && !/retDistDFeInt|retEnvEvento/.test(r.body)) throw new Error(`Receita respondeu HTTP ${r.status}: ${r.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`);
  return new DOMParser().parseFromString(r.body, 'text/xml');
}

// ---------- XML ----------
const all = (el, name) => el ? Array.from(el.getElementsByTagNameNS('*', name)) : [];
const first = (el, name) => all(el, name)[0] || null;
const txt = (el, name) => { const e = first(el, name); return e ? String(e.textContent).trim() : ''; };
const num = s => Number(String(s || '0').replace(',', '.')) || 0;
const chaveInfo = ch => ({ cnpjEmit: ch.slice(6, 20), modelo: ch.slice(20, 22), serie: String(+ch.slice(22, 25)), numero: String(+ch.slice(25, 34)) });

// ---------- Ciência da Operação (evento 210210) ----------
function dataHora() {
  // horário de Brasília (UTC-3), formato exigido: AAAA-MM-DDThh:mm:ss-03:00
  const d = new Date(Date.now() - 3 * 3600e3 - 60e3);
  return d.toISOString().slice(0, 19) + '-03:00';
}
function eventoCiencia(chave, cert) {
  const id = `ID210210${chave}01`;
  const xml = `<evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><infEvento Id="${id}"><cOrgao>91</cOrgao><tpAmb>${AMB}</tpAmb><CNPJ>${CNPJ}</CNPJ><chNFe>${chave}</chNFe><dhEvento>${dataHora()}</dhEvento><tpEvento>210210</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Ciencia da Operacao</descEvento></detEvento></infEvento></evento>`;
  const sig = new SignedXml({
    privateKey: cert.keyPem, publicCert: cert.certPem,
    signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  });
  sig.addReference({
    xpath: "//*[local-name(.)='infEvento']",
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'],
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
  });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='infEvento']", action: 'after' } });
  return sig.getSignedXml();
}
async function enviarCiencia(chaves, cert) {
  const ok = [];
  for (let i = 0; i < chaves.length; i += 20) {
    const lote = chaves.slice(i, i + 20);
    const inner = `<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4"><envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><idLote>${Date.now().toString().slice(-15)}</idLote>${lote.map(c => eventoCiencia(c, cert).replace(/^<\?xml[^>]*>/, '')).join('')}</envEvento></nfeDadosMsg>`;
    const doc = await soap(EVENTO_URL, 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento', inner, cert);
    const ret = first(doc, 'retEnvEvento');
    if (!ret) throw new Error('Resposta inesperada ao registrar Ciência da Operação.');
    log(`Ciência: lote ${txt(ret, 'cStat')} ${txt(ret, 'xMotivo')}`);
    for (const ev of all(ret, 'retEvento')) {
      const cs = txt(ev, 'cStat'), ch = txt(ev, 'chNFe');
      if (['135', '136', '573'].includes(cs)) ok.push(ch);        // registrado / vinculado / já registrado
      else log(`  ${ch}: ${cs} ${txt(ev, 'xMotivo')}`);
    }
  }
  return ok;
}

// ---------- Distribuição DF-e ----------
async function distDFe(corpo, cert) {
  const inner = `<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg><distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>${AMB}</tpAmb><cUFAutor>${UF_COD}</cUFAutor><CNPJ>${CNPJ}</CNPJ>${corpo}</distDFeInt></nfeDadosMsg></nfeDistDFeInteresse>`;
  const doc = await soap(DIST_URL, 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse', inner, cert);
  const ret = first(doc, 'retDistDFeInt');
  if (!ret) throw new Error('Resposta inesperada da Distribuição DF-e.');
  const docs = all(ret, 'docZip').map(z => ({
    nsu: z.getAttribute('NSU'), schema: z.getAttribute('schema') || '',
    xml: zlib.gunzipSync(Buffer.from(String(z.textContent).trim(), 'base64')).toString('utf8'),
  }));
  return { cStat: txt(ret, 'cStat'), xMotivo: txt(ret, 'xMotivo'), ultNSU: txt(ret, 'ultNSU'), maxNSU: txt(ret, 'maxNSU'), docs };
}

// Converte um documento recebido no formato que o sistema guarda
function interpretar(d, saida) {
  const x = new DOMParser().parseFromString(d.xml, 'text/xml');
  if (d.schema.startsWith('resNFe')) {
    const ch = txt(x, 'chNFe');
    const cs = txt(x, 'cSitNFe');
    saida.push({ chave: ch, resumo: { ...chaveInfo(ch), emitCnpj: txt(x, 'CNPJ') || txt(x, 'CPF'), emitNome: txt(x, 'xNome'), dhEmi: txt(x, 'dhEmi'), valor: num(txt(x, 'vNF')), situacao: cs === '3' ? 'cancelada' : cs === '2' ? 'denegada' : 'autorizada', nsu: d.nsu } });
  } else if (d.schema.startsWith('procNFe')) {
    const inf = first(x, 'infNFe');
    const ch = (inf && inf.getAttribute('Id') || '').replace(/^NFe/, '') || txt(x, 'chNFe');
    const emit = first(x, 'emit');
    if (txt(emit, 'CNPJ') === CNPJ) return;   // nota emitida pela própria Dtruck: não é entrada de fornecedor
    // parcelas (duplicatas) e forma de pagamento: viram contas a pagar no sistema
    const parcelas = all(x, 'dup').map(u => ({ n: txt(u, 'nDup'), venc: txt(u, 'dVenc'), valor: num(txt(u, 'vDup')) })).filter(p => p.valor > 0);
    const cfops = [...new Set(all(x, 'CFOP').map(c => String(c.textContent).trim()))];
    const categoria = cfops.length && cfops.every(c => c.endsWith('551')) ? 'investimento'
      : cfops.length && cfops.every(c => c.endsWith('556')) ? 'outras_desp' : 'compra_pecas';
    const operacaoFinanceira = cfops.some(c => CFOP_FIN.has(c.slice(1)));
    saida.push({ chave: ch, xml: d.xml, resumo: { ...chaveInfo(ch), emitCnpj: txt(emit, 'CNPJ') || txt(emit, 'CPF'), emitNome: txt(emit, 'xNome'), dhEmi: txt(x, 'dhEmi'), valor: num(txt(first(x, 'ICMSTot'), 'vNF')), situacao: 'autorizada', nsu: d.nsu, parcelas, tPag: txt(first(x, 'pag'), 'tPag'), categoria, cfops, finNFe: txt(x, 'finNFe'), operacaoFinanceira } });
  } else if (d.schema.startsWith('resEvento') || d.schema.startsWith('procEventoNFe')) {
    const tp = txt(x, 'tpEvento'), ch = txt(x, 'chNFe');
    if (tp === '110111' && ch) saida.push({ chave: ch, resumo: { ...chaveInfo(ch), situacao: 'cancelada' } });
  }
}

// ---------- Principal ----------
async function main() {
  if (!env.CERT_PFX_BASE64 || !env.DFE_TOKEN) { log('Certificado digital ou DFE_TOKEN ainda não configurados nos segredos do GitHub. Nada a fazer.'); return; }
  for (const k of ['CERT_PFX_BASE64', 'CERT_PASSWORD', 'DFE_TOKEN', 'API_URL']) if (!env[k]) throw new Error(`Falta configurar ${k}.`);
  if (CNPJ.length !== 14) throw new Error('DTRUCK_CNPJ inválido.');
  if (!UF_COD) throw new Error('DTRUCK_UF inválida (use a sigla, ex.: RS).');

  // Diagnóstico seguro: só tamanho e formato, nunca o conteúdo
  const b64 = String(env.CERT_PFX_BASE64 || '').replace(/\s+/g, '');
  const tok = String(env.DFE_TOKEN || '').trim();
  log(`Conferência dos segredos: CERT_PFX_BASE64 com ${b64.length} caracteres${/^[A-Za-z0-9+/]+=*$/.test(b64) ? '' : ' (formato inválido)'}${b64.startsWith('MII') ? '' : ' (não parece um certificado .pfx)'}; DFE_TOKEN com ${tok.length} caracteres${/^[0-9a-f]{64}$/.test(tok) ? '' : ' (esperado: 64 letras e números)'}; CERT_PASSWORD ${env.CERT_PASSWORD ? 'preenchida' : 'vazia'}.`);
  if (b64.length < 1000) throw new Error('O segredo CERT_PFX_BASE64 está curto demais para ser um certificado. Cole de novo o texto copiado pelo botão "Copiar CERT_PFX_BASE64" do sistema.');
  let cert;
  try { cert = lerCertificado(); }
  catch (e) { throw new Error(/password|MAC|Invalid/i.test(e.message) ? 'A senha do certificado (CERT_PASSWORD) não confere com o arquivo.' : 'Não consegui ler o certificado (CERT_PFX_BASE64): ' + e.message); }
  log(`Certificado válido até ${cert.validade} (${cert.dias} dias).`);
  const api = (path, opts = {}) => fetch(API + path, { ...opts, headers: { authorization: 'Bearer ' + String(env.DFE_TOKEN).trim(), 'content-type': 'application/json', ...(opts.headers || {}) } });
  const er = await api('/api/robo/estado');
  if (!er.ok) throw new Error(`Sistema respondeu ${er.status} ao pedir o estado. Confira API_URL e DFE_TOKEN.`);
  const estado = await er.json();
  log(`Último NSU: ${estado.ultNSU} · sem ciência: ${estado.semCiencia.length} · sem XML: ${estado.semXml.length} · fila: ${estado.fila.length}`);

  const lote = { docs: [], ciencia: [], buscadas: [], filaRespostas: [], ultNSU: estado.ultNSU, ok: true, status: '' };
  const avisos = [];
  if (cert.dias < 30) avisos.push(`Certificado digital vence em ${cert.dias} dias (${cert.validade}).`);

  try {
    // 1) Ciência da Operação para as notas que só chegaram em resumo
    if (estado.semCiencia.length) lote.ciencia = await enviarCiencia(estado.semCiencia, cert);

    // 2) Novos documentos pelo NSU
    let ult = estado.ultNSU, rodadas = 0, fim = false;
    while (!fim && rodadas++ < MAX_LOOPS) {
      const r = await distDFe(`<distNSU><ultNSU>${ult.padStart(15, '0')}</ultNSU></distNSU>`, cert);
      log(`NSU ${ult}: ${r.cStat} ${r.xMotivo} · ${r.docs.length} doc(s) · max ${r.maxNSU}`);
      if (r.cStat === '656') { avisos.push('A Receita pediu para aguardar 1 hora (consumo indevido). Próxima rodada tenta de novo.'); break; }
      if (!['137', '138'].includes(r.cStat)) { avisos.push(`Receita: ${r.cStat} ${r.xMotivo}`); lote.ok = false; break; }
      r.docs.forEach(d => interpretar(d, lote.docs));
      if (/^\d+$/.test(r.ultNSU)) ult = r.ultNSU.padStart(15, '0');
      fim = r.cStat === '137' || !r.maxNSU || ult >= r.maxNSU.padStart(15, '0');
    }
    lote.ultNSU = ult;

    // 3) Busca pela chave: notas sem XML há muito tempo e chaves bipadas no sistema
    for (const ch of [...new Set([...estado.semXml, ...estado.fila])]) {
      const r = await distDFe(`<consChNFe><chNFe>${ch}</chNFe></consChNFe>`, cert);
      log(`Chave ${ch.slice(0, 6)}…${ch.slice(-6)}: ${r.cStat} ${r.xMotivo}`);
      const antes = lote.docs.length;
      r.docs.forEach(d => interpretar(d, lote.docs));
      if (estado.semXml.includes(ch)) lote.buscadas.push(ch);
      if (estado.fila.includes(ch)) {
        const veioResumo = lote.docs.slice(antes).some(d => d.chave === ch && !d.xml);
        lote.filaRespostas.push({ chave: ch, msg: r.cStat === '138' ? (veioResumo ? 'Encontrada. Ciência enviada; o XML completo chega na próxima consulta.' : 'Encontrada.') : `${r.cStat} ${r.xMotivo}` });
      }
      if (r.cStat === '656') break;
    }
    // resumos recém-chegados (inclusive da fila) recebem ciência já nesta rodada
    const novosResumos = [...new Set(lote.docs.filter(d => !d.xml && d.resumo && d.resumo.situacao === 'autorizada').map(d => d.chave))]
      .filter(ch => !lote.ciencia.includes(ch) && !lote.docs.some(d => d.chave === ch && d.xml));
    if (novosResumos.length) lote.ciencia.push(...await enviarCiencia(novosResumos, cert));
  } catch (e) {
    lote.ok = false; avisos.push(e.message);
    falha(e.message);
  }

  const completos = lote.docs.filter(d => d.xml).length, resumos = lote.docs.length - completos;
  lote.status = [`${completos} nota(s) completa(s), ${resumos} resumo(s), ${lote.ciencia.length} ciência(s) registrada(s).`, ...avisos].join(' ');
  const r = await api('/api/robo/lote', { method: 'POST', body: JSON.stringify(lote) });
  if (!r.ok) throw new Error(`Sistema respondeu ${r.status} ao receber o lote.`);
  log('Enviado ao sistema: ' + lote.status);
}

main().catch(async e => {
  falha(e.message);
  // avisa o sistema que a rodada falhou (sem mexer no NSU), para aparecer na tela de entrada
  try {
    if (API && env.DFE_TOKEN) {
      const r = await fetch(API + '/api/robo/lote', { method: 'POST', headers: { authorization: 'Bearer ' + String(env.DFE_TOKEN).trim(), 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, status: 'Falha: ' + e.message }) });
      log(r.ok ? 'Falha registrada no sistema.' : `O sistema recusou o aviso de falha (HTTP ${r.status})${r.status === 401 ? ': o DFE_TOKEN do GitHub não confere com o do sistema.' : '.'}`);
    }
  } catch (_) {}
});
