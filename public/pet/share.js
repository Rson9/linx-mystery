// 只使用公开结算元数据。卡片不含谜底、问题原文、录音或玩家身份，不上传服务器。
export async function saveCaseCard({ title, score, questions, hintsUsed, elapsedSeconds }, character) {
  const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1350;
  const ctx = canvas.getContext('2d');
  const text = (value, x, y, size, color = '#315c47', align = 'left') => {
    ctx.font = `500 ${size}px "PingFang SC",system-ui,sans-serif`; ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(String(value), x, y);
  };
  ctx.fillStyle = '#f4f5eb'; ctx.fillRect(0, 0, 1080, 1350);
  const glow = ctx.createRadialGradient(540, 640, 50, 540, 640, 350); glow.addColorStop(0, '#d9e8c9'); glow.addColorStop(1, '#f4f5eb');
  ctx.fillStyle = glow; ctx.fillRect(100, 300, 880, 680);
  ctx.strokeStyle = '#d9e2cc'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(540, 630, 265, 0, Math.PI * 2); ctx.stroke();
  text('谜声 / 小矽的推理电台', 80, 94, 28); text('MY SPOILER-FREE CASE CARD', 80, 137, 17, '#95a584');
  text('这一局，想通了。', 80, 254, 62); text(`《${title}》`, 80, 323, 37, '#718963');
  if (character) {
    const svg = character.cloneNode(true); svg.querySelector('.talk-mouth')?.remove();
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('角色图像生成失败')); image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`; });
    ctx.drawImage(image, 320, 390, 440, 453);
  }
  text(score, 540, 966, 130, '#315c47', 'center'); text('破案得分', 540, 1016, 25, '#91a17e', 'center');
  const time = Number.isFinite(elapsedSeconds) ? `${Math.floor(elapsedSeconds / 60)}分${elapsedSeconds % 60}秒` : '未记录';
  for (const [i, [label, value]] of [['计分提问', `${questions} 次`], ['使用提示', `${hintsUsed} 次`], ['这一局用时', time]].entries()) {
    const x = 220 + i * 320; text(value, x, 1113, 36, '#527047', 'center'); text(label, x, 1154, 20, '#91a17e', 'center');
  }
  text('不是所有答案，都在第一眼。', 540, 1246, 27, '#708663', 'center');
  text('github.com/Rson9/linx-mystery', 540, 1296, 18, '#a0ac92', 'center');
  const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('破案卡生成失败')), 'image/png'));
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url;
  link.download = `谜声-${title.replace(/[\\/:*?"<>|]/g, '_')}-${score}分.png`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
