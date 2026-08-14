// 测试 DeepSeek API 的 reasoning_content 行为
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL,
});

async function testReasoning() {
  console.log('=== 测试 1: 不传 thinking 参数 ===');

  const response1 = await client.chat.completions.create({
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'user', content: '1+1=?' }
    ],
  });

  console.log('返回结果:');
  console.log('- content:', response1.choices[0].message.content);
  console.log('- reasoning_content:', response1.choices[0].message.reasoning_content);
  console.log('- 是否存在 reasoning_content 字段:', 'reasoning_content' in response1.choices[0].message);

  console.log('\n=== 测试 2: 显式禁用 thinking ===');

  const response2 = await client.chat.completions.create({
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'user', content: '2+2=?' }
    ],
    thinking: { type: 'disabled' },
  });

  console.log('返回结果:');
  console.log('- content:', response2.choices[0].message.content);
  console.log('- reasoning_content:', response2.choices[0].message.reasoning_content);
  console.log('- 是否存在 reasoning_content 字段:', 'reasoning_content' in response2.choices[0].message);

  console.log('\n=== 测试 3: 显式启用 thinking ===');

  const response3 = await client.chat.completions.create({
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'user', content: '3+3=?' }
    ],
    thinking: { type: 'enabled' },
  });

  console.log('返回结果:');
  console.log('- content:', response3.choices[0].message.content);
  console.log('- reasoning_content:', response3.choices[0].message.reasoning_content);
  console.log('- 是否存在 reasoning_content 字段:', 'reasoning_content' in response3.choices[0].message);

  console.log('\n=== 测试 4: 有工具调用时的行为 ===');

  const response4 = await client.chat.completions.create({
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
          properties: {
            path: { type: 'string' }
          },
          required: ['path']
        }
      }
    }],
  });

  console.log('返回结果:');
  console.log('- content:', response4.choices[0].message.content);
  console.log('- reasoning_content:', response4.choices[0].message.reasoning_content);
  console.log('- tool_calls:', response4.choices[0].message.tool_calls?.length || 0);
  console.log('- 是否存在 reasoning_content 字段:', 'reasoning_content' in response4.choices[0].message);
}

testReasoning().catch(console.error);
