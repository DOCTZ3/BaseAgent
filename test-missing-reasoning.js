// 测试：不回传 reasoning_content 是否会报错
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL,
});

async function testMissingReasoning() {
  console.log('=== 第一轮：模型返回工具调用 ===');

  const response1 = await client.chat.completions.create({
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'user', content: '读取 package.json 文件' }
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取文件',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }
    }],
  });

  const msg1 = response1.choices[0].message;
  console.log('返回:');
  console.log('- reasoning_content 存在:', 'reasoning_content' in msg1);
  console.log('- reasoning_content 值:', msg1.reasoning_content);
  console.log('- tool_calls:', msg1.tool_calls?.length || 0);

  console.log('\n=== 第二轮：不回传 reasoning_content ===');

  try {
    const response2 = await client.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: '读取 package.json 文件' },
        {
          role: 'assistant',
          content: msg1.content || null,
          // ❌ 故意不回传 reasoning_content
          tool_calls: msg1.tool_calls,
        },
        {
          role: 'tool',
          tool_call_id: msg1.tool_calls[0].id,
          content: '{"name": "test-package"}',
        }
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: '读取文件',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path']
          }
        }
      }],
    });

    console.log('✓ 成功！没有报错');
    console.log('返回:', response2.choices[0].message.content);
  } catch (error) {
    console.log('✗ 报错了！');
    console.log('错误信息:', error.message);
    console.log('状态码:', error.status);
  }

  console.log('\n=== 第三轮：正确回传 reasoning_content ===');

  try {
    const response3 = await client.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: '读取 package.json 文件' },
        {
          role: 'assistant',
          content: msg1.content || null,
          reasoning_content: msg1.reasoning_content,  // ✓ 正确回传
          tool_calls: msg1.tool_calls,
        },
        {
          role: 'tool',
          tool_call_id: msg1.tool_calls[0].id,
          content: '{"name": "test-package"}',
        }
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: '读取文件',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path']
          }
        }
      }],
    });

    console.log('✓ 成功！');
    console.log('返回:', response3.choices[0].message.content);
  } catch (error) {
    console.log('✗ 报错了！');
    console.log('错误信息:', error.message);
  }
}

testMissingReasoning().catch(console.error);
