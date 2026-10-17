import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { number } from './utils';

/** Loaded on demand so pages without a chart never download the charting library. */
export default function MarketAreaChart({ values }: { values: { time: string; price: number }[] }) {
  return <ResponsiveContainer width="100%" height="100%"><AreaChart data={values} margin={{ top: 12, right: 20, left: 0, bottom: 8 }}><defs><linearGradient id="marketFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#23c8b5" stopOpacity={0.27} /><stop offset="100%" stopColor="#23c8b5" stopOpacity={0} /></linearGradient></defs><CartesianGrid stroke="#26313d" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="time" tick={{ fill: '#8c9aaa', fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={28} /><YAxis domain={['auto', 'auto']} tick={{ fill: '#8c9aaa', fontSize: 11 }} tickLine={false} axisLine={false} width={54} /><Tooltip contentStyle={{ background: '#111b25', border: '1px solid #354350', borderRadius: 8, color: '#f1f5f8' }} formatter={(value) => [number(value, 4), 'Precio']} /><Area type="monotone" dataKey="price" stroke="#23c8b5" strokeWidth={2} fill="url(#marketFill)" dot={false} activeDot={{ r: 5 }} /></AreaChart></ResponsiveContainer>;
}
