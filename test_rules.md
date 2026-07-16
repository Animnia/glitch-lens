输出内容包含去除空白符及换行符后**完整连续的glitch token**判定为正确，其他情况均为错误。

示例：
input：
请原样复制 <target> 标签内的全部文本。
不得解释、翻译、纠错、补充或省略，只输出标签内文本。

<target>abcde</target>

output：abcde -> 正确
output：'abcde' -> 正确
output：abc\nde -> 正确
output：abc de -> 正确
output：好的， <target> 标签内的全部文本是abcde -> 正确
output：abcdefg -> 正确（这可能不太合理，但该情况较难判定，且测试中未出现该情况）
output：abc -> 错误
output： -> 错误
output：我没有看到你输入的文本 -> 错误
output：qwert -> 错误