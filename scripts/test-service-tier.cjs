const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function functions(file, names) {
  const source = fs.readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file, source, 99, true, ts.ScriptKind.JS);
  return names.map(name => {
    const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert(fn, `Missing production function ${name}`);
    return fn.getText(tree);
  }).join('\n');
}

(async () => {
  for (const prefix of ['']) {
    const root = `${process.env.CODEX_WEB_TEST_WEBVIEW || 'scratch/asar/webview'}/${prefix}assets/`;
    const shared = functions(root + 'app-shared-8bd9d0399038.js', ['mjt', 'hjt', 'rP', 'gjt', '_jt', 'yjt', 'bjt', 'noi', '$ai', 'eoi', 'Yai', 'Xai', 'Zai', 'Jai', 'qai']);
    const initial = functions(root + 'app-initial-6350d04672d0.js', ['KVi', 'bga', 'kJ', 'DWi', 'fVi', 'xga', 'codexWebIsMagpie', 'codexWebIsGptModel', 'codexWebLimitServiceTier', 'codexWebServiceTierModel']);
    const config = {model: 'gpt-6-astra', model_provider: 'custom', model_providers: {custom: {wire_api: 'responses', base_url: 'http://127.0.0.1:3425/v1'}}};
    const state = {auth: 'apikey', preference: {type: 'custom', serviceTier: 'priority'}, requirements: {requirements: {}}, config};
    const models = ['gpt-6-astra', 'gpt-6-luna', 'deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro'].map(model => ({model, serviceTiers: [], defaultServiceTier: null}));
    const scope = {get: () => state.preference, query: {setData() {}}};
    const context = vm.createContext({
      console, NG() {}, G: () => 'fixture-host', BYe: () => ({authMethod: state.auth}),
      Zs: token => token === 'MG' ? {data: state.config, isLoading: false} : token === 'Hd' ? {data: state.requirements, isPending: false} : null,
      us: () => ({useMemo: fn => fn()}), _ga: async () => state.auth,
      HLi: async () => ({config: state.config}), hm: value => value,
      KPe: async () => state.requirements, jg: () => ({sendRequest: async () => ({data: models})}),
      gr: {error: (_message, details) => {throw details.sensitive.error;}},
      kWi: {c: () => []}, AWi: {use() {}}, Di: () => scope, MA: () => ({hostId: 'fixture-host'}),
      JRi: () => ({data: {models}, isLoading: false}), CWi: () => ({serviceTier: 'priority', isLoading: false}), wWi: () => async () => {},
      ...Object.fromEntries(['Li', 'MG', 'Hd', 'iHe', 'q', 'LG', 'FG', 'Ste', 'cUi', 'sUi'].map(key => [key, key])),
    });
    vm.runInContext(`${shared}\nconst wjt='default',Cjt='ultrafast',roi='default',ioi={value:'default'},D3={};
      const oee=mjt,RZe=bjt,dJe=noi,sve=yjt,Qhe=$ai,Rwe=Yai,vne=hjt,sHe=eoi;
      ${initial}`, context);

    const settings = model => context.DWi(null, {modelSettings: {model, isLoading: false}, setModelAndReasoningEffort() {}}, null, false, null).serviceTierSettings;
    for (const model of models.map(m => m.model)) {
      const gpt = model.startsWith('gpt-');
      const selected = settings(model);
      assert.deepEqual(Array.from(selected.availableOptions, option => option.value), gpt ? ['default', 'priority'] : ['default'], `${model}: visible speed options`);
      assert.equal(selected.serviceTierForRequest, gpt ? 'priority' : null, `${model}: composer request after switching from GPT Fast`);
      assert.equal(await context.kJ(scope, 'fixture-host', model), gpt ? 'priority' : null, `${model}: saved Fast preference`);
      assert.equal(await context.kJ(scope, 'fixture-host', model, 'priority'), gpt ? 'priority' : null, `${model}: explicit Fast override`);
    }
    assert.equal(await context.kJ(scope, 'fixture-host', 'gpt-6-astra', 'fast'), 'priority');
    assert.equal(await context.kJ(scope, 'fixture-host', 'gpt-6-astra', 'ultrafast'), null);
    state.preference = {type: 'standard'};
    assert.equal(await context.kJ(scope, 'fixture-host', 'gpt-6-astra'), null);
    state.preference = {type: 'fromConfig'};
    state.config.service_tier = 'fast';
    assert.equal(await context.kJ(scope, 'fixture-host', 'gpt-6-astra'), 'priority');
    assert.equal(await context.kJ(scope, 'fixture-host', 'deepseek/deepseek-flash'), null);
    state.requirements = {requirements: {featureRequirements: {fast_mode: false}}};
    assert.equal(await context.kJ(scope, 'fixture-host', 'gpt-6-astra', 'priority'), null, 'Managed policy can disable Fast');
    state.requirements = {requirements: {}};
    state.config.model_providers.custom.base_url = 'https://unrelated.example.invalid/v1';
    assert.equal(await context.kJ(scope, 'fixture-host', 'gpt-6-astra', 'priority'), null, 'Unconfigured API providers do not gain Fast');
    state.auth = 'chatgpt';
    assert.equal(await context.kJ(scope, 'fixture-host', 'gpt-6-astra', 'ultrafast'), 'ultrafast', 'Subscription behavior is preserved');
    console.log(`${prefix || 'full/'}: production composer and request resolver passed GPT/DeepSeek switching, Standard/Fast, policy and auth checks`);
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
