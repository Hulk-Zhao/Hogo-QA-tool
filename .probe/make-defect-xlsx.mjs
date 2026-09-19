/**
 * make-defect-xlsx.mjs —— 生成「旧工具双 sheet 格式」样本（零外部依赖，仅用仓库内 xlsx）。
 * 用途：P0-1 真实浏览器验收里，让**柏拉图**也有真实不良数据可画，
 * 而不是只走「无不良记录」提示分支。
 */
import XLSX from 'xlsx';
import fs from 'node:fs';

const OUT = 'E:/tools/Hogo-QA-tool/.probe/p0-sample.xlsx';

const dim = [['物料名称', '测量值', 'USL', 'LSL']];
const push = (name, base, usl, lsl, amp) => {
  for (let i = 0; i < 60; i += 1) {
    const v = (base + Math.sin(i * 0.7) * amp + (i % 5) * 0.003).toFixed(4);
    dim.push([name, Number(v), usl, lsl]);
  }
};
push('外壳长度', 50.0, 50.2, 49.8, 0.03);
push('转轴直径', 12.0, 12.02, 11.98, 0.006);

const defect = [
  ['不良类型', '不良数量'],
  ['毛刺', 42],
  ['尺寸超差', 27],
  ['划伤', 18],
  ['变形', 9],
  ['其他', 5],
];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dim), '尺寸数据');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(defect), '不良数据');
XLSX.writeFile(wb, OUT, { bookType: 'xlsx' });
console.log('written ' + OUT + ' bytes=' + fs.statSync(OUT).size);