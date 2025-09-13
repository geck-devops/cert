// public/js/view-anim.js
function startConfetti(){
  const container = document.getElementById('confetti');
  if (!container) return;
  const colours = ['#f94144','#f3722c','#f8961e','#90be6d','#577590','#43aa8b','#277da1'];
  const count = 40;
  for (let i=0;i<count;i++){
    const el = document.createElement('div');
    el.style.position='absolute';
    el.style.width='10px';
    el.style.height='14px';
    el.style.left = Math.random()*100 + '%';
    el.style.top = -10 + 'px';
    el.style.background = colours[Math.floor(Math.random()*colours.length)];
    el.style.opacity = '0.95';
    el.style.transform = `rotate(${Math.random()*360}deg)`;
    el.style.borderRadius = '2px';
    el.style.pointerEvents = 'none';
    el.style.zIndex = 9999;
    el.style.animation = `fall ${3+Math.random()*2}s linear forwards`;
    container.appendChild(el);
    setTimeout(()=> el.remove(), 6000);
  }

  // add keyframes dynamically
  const styleId = 'confetti-anim';
  if (!document.getElementById(styleId)){
    const s = document.createElement('style');
    s.id = styleId;
    s.innerHTML = `
      @keyframes fall {
        0% { transform: translateY(0) rotate(0); opacity:1; }
        100% { transform: translateY(800px) rotate(360deg); opacity:0.85; }
      }`;
    document.head.appendChild(s);
  }
}
window.startConfetti = startConfetti;
