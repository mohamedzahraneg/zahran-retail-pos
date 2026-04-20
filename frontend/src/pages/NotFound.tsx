import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center">
      <div className="text-8xl mb-4">🧐</div>
      <h1 className="text-4xl font-black text-slate-800 mb-2">404</h1>
      <p className="text-slate-500 mb-6">الصفحة اللي بتدور عليها مش موجودة</p>
      <Link to="/" className="btn-primary">
        العودة للرئيسية
      </Link>
    </div>
  );
}
