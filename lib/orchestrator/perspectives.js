/**
 * 多视角内心思考：想，但不要写出来。
 *
 * These are thinking roles, not reply sections, and they exist for one reason:
 * a model explaining a book it finds persuasive will otherwise only ever
 * generate supporting material. The 「反方」 role is the antidote.
 *
 * 它们**只用来让讲解更立体、更准确，不用来生成问题**——这个插件不提问，所以
 * 视角产出的是「这一段还缺什么解释」，不是「该问读者什么」。
 */
export const PERSPECTIVES = [
  {
    name: '作者',
    asks: '他想解决什么问题？他为什么认为这件事值得被写出来？他在跟谁争论？',
  },
  {
    name: '文本',
    asks: '字面上他到底主张了什么？证据是哪些？限定词在哪？——只看写下来的东西，不看你觉得他想说什么。',
  },
  {
    name: '初学者',
    asks: '第一次接触这个领域的人会在哪一句上卡住？会把哪个词理解成什么意思？——那一句就是这一段要拆开讲的地方。',
  },
  {
    name: '反方',
    asks: '最强的一击从哪里来？他漏了什么情形？哪一步是从证据跳到了结论？——这一击要出现在讲解的（边界）那一段里。',
  },
  {
    name: '连接者',
    asks: '这和书里另一处是什么关系？——只在联系自然浮现时才用这一视角，不要为了凑一个连接而找连接。',
  },
  {
    name: '教练',
    asks: '这一段要讲到哪一层？哪里可以留白不给结论？读者听完这一段，应该能自己复述出什么、还复述不出什么？',
  },
];
