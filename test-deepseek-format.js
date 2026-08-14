// 测试 DeepSeek API 对 assistant 消息的要求
const message1 = {
  role: 'assistant',
  content: '',  // 空字符串
  tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }]
};

const message2 = {
  role: 'assistant',
  content: null,  // null
  tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }]
};

const message3 = {
  role: 'assistant',
  // content 字段完全不存在
  tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }]
};

console.log('空字符串:', JSON.stringify(message1, null, 2));
console.log('\nnull:', JSON.stringify(message2, null, 2));
console.log('\n不包含 content:', JSON.stringify(message3, null, 2));
