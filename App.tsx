import React, { useState, useEffect } from 'react';
import { Upload, Download, Sparkles, RefreshCw, Layers, Settings, Scissors, Palette, ShieldCheck, ShieldAlert, ArrowRight, ArrowDown, AlignCenter, ArrowDownToLine, Target, Maximize, Images } from 'lucide-react';
import { SpriteConfig, ImageDimensions, ProcessingState, CropConfig } from './types';
import { SpriteCanvas } from './components/SpriteCanvas';
import { PreviewPlayer } from './components/PreviewPlayer';
import { analyzeSpriteSheet } from './services/geminiService';
import { generateGif } from './utils/gifBuilder';
import { exportFrames } from './utils/frameExporter';

const INITIAL_CONFIG: SpriteConfig = {
  rows: 4,
  cols: 4,
  totalFrames: 16,
  excludedFrames: [], // Init empty
  fps: 12,
  scale: 1,
  transparent: null,
  tolerance: 10,
  useFloodFill: true, 
  autoAlign: false, 
  alignMode: 'center', // Default align mode
  readOrder: 'row-major',
  crop: { top: 0, bottom: 0, left: 0, right: 0 },
  maxResolution1024: false
};

interface NumberInputProps {
  label: string;
  value: number;
  onChange: (val: number) => void;
  min?: number;
  max?: number;
}

const NumberInput: React.FC<NumberInputProps> = ({ label, value, onChange, min = 1, max }) => {
  const [localValue, setLocalValue] = useState<string>(value.toString());

  useEffect(() => {
    setLocalValue(value.toString());
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    setLocalValue(newVal);
    if (newVal !== '' && !isNaN(Number(newVal))) {
      onChange(Number(newVal));
    }
  };

  const handleBlur = () => {
    if (localValue === '' || isNaN(Number(localValue))) {
      setLocalValue(value.toString());
    } else {
       let num = Number(localValue);
       if (min !== undefined && num < min) num = min;
       if (max !== undefined && num > max) num = max;
       if (num.toString() !== localValue) {
         setLocalValue(num.toString());
       }
       onChange(num);
    }
  };

  return (
    <div className="space-y-2">
      <label className="text-xs uppercase font-bold text-slate-500">{label}</label>
      <input 
        type="number"
        min={min}
        max={max}
        value={localValue}
        onChange={handleChange}
        onBlur={handleBlur}
        className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
      />
    </div>
  );
};

const App: React.FC = () => {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<ImageDimensions>({ width: 0, height: 0 });
  const [config, setConfig] = useState<SpriteConfig>(INITIAL_CONFIG);
  const [processingState, setProcessingState] = useState<ProcessingState>({ status: 'idle', progress: 0 });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (typeof ev.target?.result === 'string') {
          setImageUrl(ev.target.result);
          setProcessingState({ status: 'idle', progress: 0 });
          setConfig(prev => ({ ...INITIAL_CONFIG, scale: 1 })); 
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleAutoDetect = async () => {
    if (!imageUrl) return;

    setProcessingState({ status: 'analyzing', progress: 0 });
    try {
      const result = await analyzeSpriteSheet(imageUrl);
      setConfig(prev => ({
        ...prev,
        rows: result.rows ?? prev.rows,
        cols: result.cols ?? prev.cols,
        totalFrames: result.totalFrames ?? ((result.rows || prev.rows) * (result.cols || prev.cols))
      }));
      setProcessingState({ status: 'idle', progress: 0 });
    } catch (error) {
      console.error("Detection failed", error);
      setProcessingState({ status: 'idle', progress: 0, error: 'AI 识别失败，请手动设置。' });
    }
  };

  const handleExportGif = async () => {
    if (!imageUrl) return;
    setProcessingState({ status: 'rendering', progress: 0 });

    try {
      const img = new Image();
      img.src = imageUrl;
      await img.decode();

      const blob = await generateGif(img, config, dimensions, (pct) => {
        setProcessingState(prev => ({ ...prev, progress: pct }));
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sprite-motion-${Date.now()}.gif`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setProcessingState({ status: 'completed', progress: 100 });
      setTimeout(() => setProcessingState({ status: 'idle', progress: 0 }), 2000);

    } catch (e: any) {
      console.error(e);
      setProcessingState({ status: 'idle', progress: 0, error: e.message || '生成 GIF 失败。' });
    }
  };

  const handleExportFrames = async () => {
    if (!imageUrl) return;
    setProcessingState({ status: 'rendering', progress: 0 });

    try {
      const img = new Image();
      img.src = imageUrl;
      await img.decode();

      const blob = await exportFrames(img, config, dimensions, (pct) => {
        setProcessingState(prev => ({ ...prev, progress: pct }));
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sprite-frames-${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setProcessingState({ status: 'completed', progress: 100 });
      setTimeout(() => setProcessingState({ status: 'idle', progress: 0 }), 2000);

    } catch (e: any) {
      console.error(e);
      setProcessingState({ status: 'idle', progress: 0, error: e.message || '导出帧失败。' });
    }
  };

  const updateConfig = (key: keyof SpriteConfig, value: any) => {
    setConfig(prev => {
       const next = { ...prev, [key]: value };
       if (key === 'rows' || key === 'cols') {
          if (prev.totalFrames === prev.rows * prev.cols) {
             next.totalFrames = next.rows * next.cols;
          }
       }
       return next;
    });
  };

  const updateCrop = (key: keyof CropConfig, value: number) => {
    setConfig(prev => ({
      ...prev,
      crop: {
        ...prev.crop,
        [key]: value
      }
    }));
  };

  const handleToggleFrame = (index: number) => {
    setConfig(prev => {
        const isExcluded = prev.excludedFrames.includes(index);
        let newExcluded;
        if (isExcluded) {
            newExcluded = prev.excludedFrames.filter(i => i !== index);
        } else {
            newExcluded = [...prev.excludedFrames, index];
        }
        return { ...prev, excludedFrames: newExcluded };
    });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex flex-col font-sans">
      <header className="bg-slate-900 border-b border-slate-800 p-4 sticky top-0 z-10 shadow-md">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-2">
             <div className="bg-indigo-600 p-2 rounded-lg shadow-lg shadow-indigo-500/20">
                <Layers className="text-white" size={24} />
             </div>
             <div>
               <h1 className="text-xl font-bold tracking-tight text-white">SpriteMotion</h1>
               <p className="text-xs text-slate-400">静态精灵图转 GIF 动画</p>
             </div>
          </div>
          
          <div className="flex items-center space-x-4">
            <a href="https://github.com" target="_blank" rel="noreferrer" className="text-slate-400 hover:text-white transition-colors text-sm">Github</a>
            {process.env.API_KEY ? (
               <span className="px-2 py-1 rounded bg-green-900/30 text-green-400 text-xs border border-green-800">Gemini 已就绪</span>
            ) : (
               <span className="px-2 py-1 rounded bg-yellow-900/30 text-yellow-400 text-xs border border-yellow-800">缺少 API Key</span>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 flex flex-col space-y-4">
          <div className="flex items-center justify-between bg-slate-900 p-3 rounded-lg border border-slate-800">
            <div className="flex items-center space-x-3">
                <label className="flex items-center space-x-2 cursor-pointer bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-md text-sm font-medium transition-all shadow-lg shadow-indigo-500/20">
                    <Upload size={16} />
                    <span>上传图片</span>
                    <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                </label>
                
                <button 
                    onClick={handleAutoDetect}
                    disabled={!imageUrl || processingState.status === 'analyzing'}
                    className={`flex items-center space-x-2 px-4 py-2 rounded-md text-sm font-medium transition-all border border-slate-700 ${!imageUrl ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-800 text-indigo-300'}`}
                >
                    {processingState.status === 'analyzing' ? <RefreshCw className="animate-spin" size={16} /> : <Sparkles size={16} />}
                    <span>自动识别</span>
                </button>
            </div>
            {imageUrl && <div className="text-xs font-mono text-slate-500">{dimensions.width}x{dimensions.height}px</div>}
          </div>

          <div className="flex-1 bg-slate-900/50 rounded-xl border border-slate-800 p-1 flex flex-col h-[65vh] min-h-[500px]">
             <SpriteCanvas 
                imageUrl={imageUrl} 
                config={config} 
                onDimensionsLoaded={setDimensions}
                onToggleFrame={handleToggleFrame} 
            />
          </div>
          
          {processingState.error && (
            <div className="bg-red-900/20 border border-red-800 text-red-200 text-sm p-3 rounded-md">
                {processingState.error}
            </div>
          )}
        </div>

        <div className="lg:col-span-5 space-y-6">
          <div className="bg-slate-900 rounded-xl border border-slate-800 p-4 shadow-xl">
            <h2 className="text-sm font-semibold text-slate-300 mb-4 flex items-center uppercase tracking-wider">
                <span className="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span>
                实时预览
            </h2>
            <PreviewPlayer imageUrl={imageUrl} config={config} dimensions={dimensions} />
          </div>

          <div className="bg-slate-900 rounded-xl border border-slate-800 p-6 shadow-xl space-y-6">
            <div className="flex items-center space-x-2 mb-4">
                <Settings className="text-indigo-400" size={20} />
                <h2 className="text-lg font-semibold text-white">参数设置</h2>
            </div>

            <div className="grid grid-cols-2 gap-4">
                <NumberInput label="行数" value={config.rows} onChange={(val) => updateConfig('rows', val)} />
                <NumberInput label="列数" value={config.cols} onChange={(val) => updateConfig('cols', val)} />
            </div>
            
            <div className="bg-slate-950 p-2 rounded-lg border border-slate-800 flex items-center justify-between">
                 <span className="text-xs font-bold text-slate-500 uppercase px-2">读取顺序</span>
                 <div className="flex bg-slate-900 rounded p-1 space-x-1">
                    <button
                        onClick={() => updateConfig('readOrder', 'row-major')}
                        className={`flex items-center space-x-1 px-3 py-1.5 rounded text-xs transition-colors ${config.readOrder === 'row-major' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
                    >
                        <ArrowRight size={14} />
                        <span>水平优先</span>
                    </button>
                    <button
                         onClick={() => updateConfig('readOrder', 'column-major')}
                         className={`flex items-center space-x-1 px-3 py-1.5 rounded text-xs transition-colors ${config.readOrder === 'column-major' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
                    >
                        <ArrowDown size={14} />
                        <span>垂直优先</span>
                    </button>
                 </div>
            </div>

            <div className="space-y-2">
                 <div className="flex justify-between">
                    <label className="text-xs uppercase font-bold text-slate-500">序列长度</label>
                    <span className="text-xs text-slate-500">最大值: {config.rows * config.cols}</span>
                 </div>
                 <input type="range" min="1" max={config.rows * config.cols} value={config.totalFrames} onChange={(e) => updateConfig('totalFrames', parseInt(e.target.value))} className="w-full accent-indigo-500 h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer" />
                 <div className="flex justify-between text-xs font-mono text-slate-400 pt-1">
                    <span>截取前 {config.totalFrames} 帧</span>
                    <span className="text-indigo-300">实际生成: {config.totalFrames - config.excludedFrames.filter(i => i < config.totalFrames).length} 帧</span>
                 </div>
            </div>

            <div className="border-t border-slate-800 pt-4">
               <div className="flex items-center justify-between mb-3 text-slate-400">
                   <div className="flex items-center space-x-2">
                      <Scissors size={16} />
                      <h3 className="text-xs font-bold uppercase">单帧裁剪</h3>
                   </div>
               </div>
               <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <NumberInput label="上边距" value={config.crop.top} min={0} onChange={(val) => updateCrop('top', val)} />
                  <NumberInput label="下边距" value={config.crop.bottom} min={0} onChange={(val) => updateCrop('bottom', val)} />
                  <NumberInput label="左边距" value={config.crop.left} min={0} onChange={(val) => updateCrop('left', val)} />
                  <NumberInput label="右边距" value={config.crop.right} min={0} onChange={(val) => updateCrop('right', val)} />
               </div>
            </div>

            {/* Auto Align Section */}
            <div className="border-t border-slate-800 pt-4">
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center space-x-2 text-slate-400">
                        <Target size={16} />
                        <h3 className="text-xs font-bold uppercase">智能对齐</h3>
                    </div>
                     <button 
                        onClick={() => updateConfig('autoAlign', !config.autoAlign)}
                        className={`flex items-center space-x-1 px-3 py-1 rounded-full border text-xs transition-all ${config.autoAlign ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-900 border-slate-700 text-slate-500'}`}
                    >
                         {config.autoAlign ? "已开启" : "未开启"}
                    </button>
                </div>
                
                {config.autoAlign && (
                    <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-2 animate-in slide-in-from-top-2">
                        <div className="text-xs text-slate-500 mb-2">
                            系统将自动扫描每一帧的主体内容，并重新构建画布以保持动画稳定。
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                onClick={() => updateConfig('alignMode', 'center')}
                                className={`flex flex-col items-center justify-center p-2 rounded border transition-all ${config.alignMode === 'center' ? 'bg-indigo-900/50 border-indigo-500 text-indigo-200' : 'bg-slate-900 border-slate-700 text-slate-500 hover:bg-slate-800'}`}
                            >
                                <AlignCenter size={18} className="mb-1"/>
                                <span className="text-[10px] font-bold">居中对齐</span>
                            </button>
                            <button
                                onClick={() => updateConfig('alignMode', 'bottom')}
                                className={`flex flex-col items-center justify-center p-2 rounded border transition-all ${config.alignMode === 'bottom' ? 'bg-indigo-900/50 border-indigo-500 text-indigo-200' : 'bg-slate-900 border-slate-700 text-slate-500 hover:bg-slate-800'}`}
                            >
                                <ArrowDownToLine size={18} className="mb-1"/>
                                <span className="text-[10px] font-bold">底部对齐 (防抖动)</span>
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-800">
                 <NumberInput label="帧率 (FPS)" value={config.fps} min={1} max={60} onChange={(val) => updateConfig('fps', val)} />
                <div className="space-y-2">
                    <label className="text-xs uppercase font-bold text-slate-500">导出缩放比例</label>
                     <select 
                        value={config.scale}
                        onChange={(e) => updateConfig('scale', parseFloat(e.target.value))}
                        className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-white focus:ring-2 focus:ring-indigo-500 outline-none h-[42px]"
                    >
                        <option value={1}>1x (原始大小)</option>
                        <option value={2}>2x (放大)</option>
                        <option value={4}>4x (像素复古)</option>
                        <option value={0.5}>0.5x (缩小)</option>
                    </select>
                    
                     <div className="flex items-center justify-between pt-1 px-1">
                        <div className="flex items-center space-x-1 text-slate-400" title="若导出尺寸超过1024px，将自动按比例缩小至1024px以内">
                            <Maximize size={12} />
                            <span className="text-[10px]">限制最大边长 1024px</span>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input 
                                type="checkbox" 
                                className="sr-only peer" 
                                checked={config.maxResolution1024} 
                                onChange={(e) => updateConfig('maxResolution1024', e.target.checked)} 
                            />
                            <div className="w-7 h-4 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-indigo-600"></div>
                        </label>
                    </div>
                </div>
            </div>

            <div className="pt-4 border-t border-slate-800">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-2 text-slate-400">
                         <Palette size={16} />
                        <h3 className="text-xs font-bold uppercase">背景透明化</h3>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" checked={config.transparent !== null} onChange={(e) => updateConfig('transparent', e.target.checked ? '#ffffff' : null)} />
                        <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
                    </label>
                </div>
                
                {config.transparent !== null && (
                    <div className="bg-slate-950 p-3 rounded-lg border border-slate-700 animate-in fade-in slide-in-from-top-2 duration-200 space-y-3">
                        <div className="flex items-center space-x-3">
                             <input type="color" value={config.transparent} onChange={(e) => updateConfig('transparent', e.target.value)} className="h-9 w-12 cursor-pointer rounded bg-transparent border-0 p-0" />
                             <div className="flex-1">
                                 <div className="text-sm font-medium text-white">透明色值</div>
                                 <div className="text-xs text-slate-500 font-mono uppercase">{config.transparent}</div>
                             </div>
                        </div>

                        <div className="space-y-1">
                            <div className="flex justify-between text-xs">
                                <span className="text-slate-400">颜色容差 (Fuzziness)</span>
                                <span className="font-mono text-indigo-300">{config.tolerance}%</span>
                            </div>
                            <input type="range" min="0" max="50" step="1" value={config.tolerance} onChange={(e) => updateConfig('tolerance', parseInt(e.target.value))} className="w-full accent-indigo-500 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer" />
                        </div>

                        <div className="flex items-center justify-between p-2 bg-slate-900 rounded border border-slate-800">
                             <div className="flex items-center space-x-2 text-xs text-slate-300">
                                {config.useFloodFill ? <ShieldCheck size={14} className="text-green-400"/> : <ShieldAlert size={14} className="text-yellow-400"/>}
                                <span>保护主体内部颜色</span>
                             </div>
                             <label className="relative inline-flex items-center cursor-pointer">
                                <input type="checkbox" className="sr-only peer" checked={config.useFloodFill} onChange={(e) => updateConfig('useFloodFill', e.target.checked)} />
                                <div className="w-7 h-4 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-green-600"></div>
                            </label>
                        </div>
                    </div>
                )}
            </div>

            <div className="pt-6 flex gap-3">
                <button 
                    onClick={handleExportGif}
                    disabled={!imageUrl || processingState.status === 'rendering'}
                    className={`flex-1 flex items-center justify-center space-x-2 py-3 rounded-xl font-bold text-base shadow-xl transition-all transform active:scale-95
                    ${!imageUrl 
                        ? 'bg-slate-800 text-slate-600 cursor-not-allowed' 
                        : processingState.status === 'rendering'
                           ? 'bg-indigo-800 text-indigo-200 cursor-wait'
                           : 'bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white shadow-indigo-900/20'
                    }`}
                >
                    {processingState.status === 'rendering' ? (
                        <>
                            <RefreshCw className="animate-spin" size={18} />
                            <span>生成中 {processingState.progress}%</span>
                        </>
                    ) : (
                        <>
                            <Download size={18} />
                            <span>导出 GIF</span>
                        </>
                    )}
                </button>

                <button 
                    onClick={handleExportFrames}
                    disabled={!imageUrl || processingState.status === 'rendering'}
                    className={`flex-1 flex items-center justify-center space-x-2 py-3 rounded-xl font-bold text-base shadow-lg transition-all transform active:scale-95 border border-slate-700
                    ${!imageUrl 
                        ? 'bg-slate-900 text-slate-700 cursor-not-allowed' 
                        : processingState.status === 'rendering'
                           ? 'bg-slate-800 text-slate-500 cursor-wait'
                           : 'bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white'
                    }`}
                >
                     <Images size={18} />
                     <span>导出每一帧 (ZIP)</span>
                </button>
            </div>

          </div>
        </div>
      </main>
    </div>
  );
};

export default App;