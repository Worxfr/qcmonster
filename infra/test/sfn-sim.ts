// Interprete minimal d'une definition Step Functions synthetisee (Task, Choice, Pass, Map en ligne, Succeed, Fail, Catch).
// Sert a rejouer la machine du pipeline avec des handlers simules. Ce n'est pas Step Functions: il ne couvre que ce que la machine utilise.
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface Def { StartAt: string; States: Record<string, Json> }
export type Handlers = Record<string, (input: Json) => Json | Promise<Json>>;
export interface Run { end: string; endType: string; calls: { state: string; input: Json }[]; output: Json }

const get = (path: string, data: Json, ctx: Json): Json => {
  const [root, rest] = path.startsWith('$$') ? [ctx, path.slice(2)] : [data, path.slice(1)];
  return rest.split('.').filter(Boolean).reduce((v: Json, k) => (v === undefined || v === null ? undefined : v[k]), root);
};
const resolve = (tpl: Json, data: Json, ctx: Json): Json => {
  if (Array.isArray(tpl)) return tpl.map((x) => resolve(x, data, ctx));
  if (tpl && typeof tpl === 'object') {
    return Object.fromEntries(Object.entries(tpl).map(([k, v]) => (k.endsWith('.$') ? [k.slice(0, -2), get(v as string, data, ctx)] : [k, resolve(v, data, ctx)])));
  }
  return tpl;
};
const put = (data: Json, path: string | null | undefined, value: Json): Json => {
  if (path === null) return data;
  if (path === undefined || path === '$') return value;
  const keys = path.slice(2).split('.');
  const out = { ...data };
  let cur = out;
  keys.slice(0, -1).forEach((k) => (cur = cur[k] = { ...(cur[k] ?? {}) }));
  cur[keys[keys.length - 1]] = value;
  return out;
};
const test = (rule: Json, data: Json): boolean => {
  if (rule.And) return rule.And.every((r: Json) => test(r, data));
  const v = get(rule.Variable, data, {});
  if ('IsPresent' in rule) return (v !== undefined) === rule.IsPresent;
  if (v === undefined) throw Object.assign(new Error(`States.Runtime: ${rule.Variable} absent`), { runtime: true });
  if ('BooleanEquals' in rule) return v === rule.BooleanEquals;
  if ('NumericGreaterThan' in rule) return v > rule.NumericGreaterThan;
  throw new Error(`condition non geree: ${JSON.stringify(rule)}`);
};

/** Etat dont le nom de Lambda est dans `Resource`/`FunctionName`: les handlers sont indexes par NOM D'ETAT. */
export async function run(def: Def, input: Json, handlers: Handlers): Promise<Run> {
  const calls: Run['calls'] = [];
  const exec = async (states: Record<string, Json>, start: string, data: Json): Promise<{ end: string; endType: string; data: Json }> => {
    let name = start;
    for (let guard = 0; guard < 200; guard++) {
      const st = states[name];
      switch (st.Type) {
        case 'Succeed': case 'Fail': return { end: name, endType: st.Type, data };
        case 'Pass': {
          data = put(data, st.ResultPath, st.Parameters ? resolve(st.Parameters, data, {}) : data);
          break;
        }
        case 'Choice': {
          const hit = st.Choices.find((c: Json) => test(c, data));
          name = hit ? hit.Next : st.Default;
          continue;
        }
        case 'Task': {
          const params = st.Parameters ? resolve(st.Parameters, data, { Task: { Token: 'token' } }) : data;
          const payload = params.Payload ?? params;
          calls.push({ state: name, input: payload });
          try {
            const h = handlers[name];
            if (!h) throw new Error(`pas de handler pour ${name}`);
            const out = await h(payload);
            data = put(data, st.ResultPath, out);
          } catch (e) {
            if ((e as { runtime?: boolean }).runtime) throw e;
            const c = (st.Catch ?? []).find((x: Json) => x.ErrorEquals.includes('States.ALL'));
            if (!c) throw e;
            data = put(data, c.ResultPath, { Error: 'Error', Cause: (e as Error).message });
            name = c.Next;
            continue;
          }
          break;
        }
        case 'Map': {
          const items = get(st.ItemsPath, data, {}) as Json[];
          const results: Json[] = [];
          try {
            for (const [n, item] of items.entries()) {
              const sel = resolve(st.ItemSelector, data, { Map: { Item: { Value: item, Index: n } } });
              results.push((await exec(st.ItemProcessor.States, st.ItemProcessor.StartAt, sel)).data);
            }
            data = put(data, st.ResultPath, results);
          } catch (e) {
            if ((e as { runtime?: boolean }).runtime) throw e;
            const c = (st.Catch ?? []).find((x: Json) => x.ErrorEquals.includes('States.ALL'));
            if (!c) throw e;
            data = put(data, c.ResultPath, { Error: 'Error', Cause: (e as Error).message });
            name = c.Next;
            continue;
          }
          break;
        }
        default: throw new Error(`type non gere: ${st.Type}`);
      }
      if (st.End) return { end: name, endType: 'End', data };
      name = st.Next;
    }
    throw new Error('boucle');
  };
  const r = await exec(def.States, def.StartAt, input);
  return { end: r.end, endType: r.endType, calls, output: r.data };
}
