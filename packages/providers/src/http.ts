/** 响应体里出现这些字样，就基本可以断定是模型 id 写错了。 */
const MODEL_HINT_RE = /model[_ ]?not[_ ]?found|invalid[_ ]?model|does not exist|no such model/i;

/**
 * 非 2xx 的统一措辞。
 *
 * 模型 id 写错在两家都表现为"一个看不懂的 404/400"，而启动期**查不了存在性**
 * （兼容端点的模型清单各不相同，硬编一张表反而会拦住合法模型）。所以这里把它翻译成人话，
 * 而不是假装能在启动期拦住（设计 §6）。
 */
export async function describeHttpFailure(
  label: string,
  response: Response,
  model: string,
): Promise<string> {
  const body = await response.text();
  const hint =
    response.status === 404 || MODEL_HINT_RE.test(body)
      ? `\n（模型 id "${model}" 在这个端点看来不存在。检查配置里的 model 项，以及 baseUrl 是否配对。）`
      : '';
  return `${label} ${response.status}: ${body}${hint}`;
}
