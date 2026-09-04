const path = location.pathname;
document.querySelectorAll('.site-nav a').forEach(link => {
  const href = link.getAttribute('href');
  if ((href === '/' && path === '/') || (href !== '/' && path.startsWith(href))) link.classList.add('active');
});
const menu = document.querySelector('[data-menu]');
menu?.addEventListener('click', () => document.querySelector('.site-nav')?.classList.toggle('open'));
