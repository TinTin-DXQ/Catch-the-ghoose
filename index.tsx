import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { motion, AnimatePresence } from 'framer-motion';
import { GoogleGenAI } from "@google/genai";
import { Sparkles, RotateCcw, Play, Info } from 'lucide-react';

// --- Configuration ---
const TILE_SIZE = 60; // Slightly smaller for better mobile fit
const DOCK_CAPACITY = 7;
const ITEM_TYPES = ['🪿', '🦆', '🐓', '🥚', '🌽', '🥕', '🚜', '🛖'];
const LEVEL_CONFIG = {
  itemCount: 33, // Divisible by 3
  gridSize: 340, // Width/Height of the play area
};

// --- Types ---
type ItemStatus = 'board' | 'dock' | 'matched';

interface GameItem {
  id: string;
  type: string;
  x: number;
  y: number;
  z: number;
  rotation: number;
  status: ItemStatus;
}

interface AICommentary {
  text: string;
  mood: 'neutral' | 'happy' | 'sarcastic';
}

// --- Helper Functions ---

const isItemCovered = (item: GameItem, allItems: GameItem[]) => {
  if (item.status !== 'board') return false;
  
  const threshold = TILE_SIZE * 0.85; 

  return allItems.some((other) => {
    if (other.id === item.id) return false;
    if (other.status !== 'board') return false;
    if (other.z <= item.z) return false;

    const dx = Math.abs(other.x - item.x);
    const dy = Math.abs(other.y - item.y);

    return dx < threshold && dy < threshold;
  });
};

const generateLevel = (): GameItem[] => {
  const items: GameItem[] = [];
  // Use a subset of types per level for playability
  const typesToUse = ITEM_TYPES.sort(() => 0.5 - Math.random()).slice(0, 6);
  
  const pool: string[] = [];
  const totalTriplets = LEVEL_CONFIG.itemCount / 3;
  
  for (let i = 0; i < totalTriplets; i++) {
    const type = typesToUse[i % typesToUse.length];
    pool.push(type, type, type);
  }

  pool.sort(() => 0.5 - Math.random());

  pool.forEach((type, index) => {
    const spread = LEVEL_CONFIG.gridSize - TILE_SIZE;
    // Concentric randomization for a "pile" look
    // Items with higher index (on top) are more central
    const centrality = 1 - (index / LEVEL_CONFIG.itemCount); 
    const maxOffset = spread / 2;
    
    // Random position with slight bias towards center for top items
    const range = maxOffset * (0.6 + (0.4 * centrality));
    
    const x = (Math.random() * range * 2) - range;
    const y = (Math.random() * range * 2) - range;
    
    items.push({
      id: `item-${index}-${Date.now()}`,
      type,
      x, 
      y,
      z: index,
      rotation: (Math.random() * 60) - 30,
      status: 'board',
    });
  });

  return items;
};

// --- Components ---

const Tile: React.FC<{ item: GameItem; isCovered: boolean; onClick: () => void }> = ({ item, isCovered, onClick }) => {
  return (
    <motion.div
      layoutId={`tile-${item.id}`}
      onClick={() => !isCovered && onClick()}
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: isCovered ? 0.8 : 1 }}
      className={`absolute flex items-center justify-center rounded-xl border-b-[6px] shadow-lg select-none cursor-pointer transition-all duration-200
        ${isCovered 
          ? 'bg-gray-100 border-gray-300 text-gray-400 grayscale brightness-90 z-0' 
          : 'bg-white border-amber-200 text-slate-800 z-10 hover:-translate-y-1 hover:shadow-xl active:scale-95 active:border-b-2 active:translate-y-1'
        }
      `}
      style={{
        width: TILE_SIZE,
        height: TILE_SIZE,
        x: item.x,
        y: item.y,
        zIndex: item.z,
        rotate: item.rotation,
      }}
    >
      <span className="text-3xl leading-none filter drop-shadow-sm pointer-events-none">{item.type}</span>
    </motion.div>
  );
};

const DockTile: React.FC<{ item: GameItem }> = ({ item }) => {
  return (
    <motion.div
      layoutId={`tile-${item.id}`}
      className="w-11 h-11 md:w-14 md:h-14 bg-white rounded-lg border-b-4 border-blue-200 shadow-md flex items-center justify-center text-2xl md:text-3xl"
      animate={{ scale: 1, rotate: 0 }}
      exit={{ scale: 0, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
    >
      {item.type}
    </motion.div>
  );
};

const App = () => {
  const [items, setItems] = useState<GameItem[]>([]);
  const [gameState, setGameState] = useState<'idle' | 'playing' | 'won' | 'lost'>('idle');
  const [dock, setDock] = useState<GameItem[]>([]);
  const [isCheckingMatch, setIsCheckingMatch] = useState(false);
  const [commentary, setCommentary] = useState<AICommentary | null>(null);
  const [loadingCommentary, setLoadingCommentary] = useState(false);

  const startGame = () => {
    setItems(generateLevel());
    setDock([]);
    setGameState('playing');
    setCommentary(null);
  };

  const boardItems = useMemo(() => items.filter(i => i.status === 'board'), [items]);
  
  const coveredStatus = useMemo(() => {
    const status: Record<string, boolean> = {};
    const sortedBoardItems = [...boardItems].sort((a, b) => b.z - a.z);
    
    for (const item of boardItems) {
      status[item.id] = isItemCovered(item, sortedBoardItems);
    }
    return status;
  }, [boardItems]);

  const handleTileClick = (clickedItem: GameItem) => {
    if (gameState !== 'playing' || isCheckingMatch) return;
    if (dock.length >= DOCK_CAPACITY) return;

    // Immediate UI update
    const updatedItems = items.map(item => 
      item.id === clickedItem.id ? { ...item, status: 'dock' as ItemStatus } : item
    );
    setItems(updatedItems);
    
    // Add to dock
    const newDock = [...dock, { ...clickedItem, status: 'dock' as ItemStatus }];
    setDock(newDock);
  };

  useEffect(() => {
    if (dock.length === 0) return;

    const checkMatch = async () => {
      // Count types
      const counts: Record<string, number> = {};
      dock.forEach(item => counts[item.type] = (counts[item.type] || 0) + 1);

      // Find match
      const matchType = Object.keys(counts).find(key => counts[key] >= 3);

      if (matchType) {
        setIsCheckingMatch(true);
        await new Promise(r => setTimeout(r, 400)); // Visual wait

        // Eliminate matches
        const toRemove = dock.filter(i => i.type === matchType).slice(0, 3).map(i => i.id);
        
        setItems(prev => prev.map(i => toRemove.includes(i.id) ? { ...i, status: 'matched' } : i));
        setDock(prev => prev.filter(i => !toRemove.includes(i.id)));
        
        setIsCheckingMatch(false);
      } else {
        // Check Win
        const remainingBoard = items.filter(i => i.status === 'board').length;
        if (remainingBoard === 0 && dock.length === 0) {
           setGameState('won');
           fetchCommentary('won');
        } 
        // Check Loss
        else if (dock.length >= DOCK_CAPACITY) {
           setGameState('lost');
           fetchCommentary('lost');
        }
      }
    };

    if (!isCheckingMatch && gameState === 'playing') {
      checkMatch();
    }
  }, [dock, items, isCheckingMatch, gameState]);

  const fetchCommentary = async (result: 'won' | 'lost') => {
    if (!process.env.API_KEY) return;
    
    setLoadingCommentary(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const prompt = result === 'won' 
        ? "Generate a celebratory, slightly chaotic message (max 15 words) for winning 'Catch the Goose'. Use farm emojis."
        : "Generate a sarcastic roast (max 15 words) for losing 'Catch the Goose' because the basket is full. Use farm emojis.";

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });

      setCommentary({
        text: response.text.trim(),
        mood: result === 'won' ? 'happy' : 'sarcastic'
      });
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingCommentary(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#FFF8E7] font-sans text-slate-800 overflow-hidden flex flex-col relative select-none">
      
      {/* Header */}
      <header className="pt-8 pb-2 flex flex-col items-center z-30 pointer-events-none">
        <h1 className="text-4xl md:text-5xl font-black text-amber-600 tracking-tighter drop-shadow-sm flex items-center gap-3">
          <span className="animate-bounce">🪿</span> Catch the Goose
        </h1>
        <p className="text-amber-800/60 font-bold mt-2 bg-amber-100 px-4 py-1 rounded-full text-sm">
          Match 3 tiles to clear!
        </p>
      </header>

      {/* Main Game Area */}
      <main className="flex-1 relative flex items-center justify-center">
        
        {/* Start Screen Overlay */}
        <AnimatePresence>
          {gameState === 'idle' && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-[#FFF8E7]/90 backdrop-blur-sm"
            >
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={startGame}
                className="bg-amber-500 hover:bg-amber-600 text-white text-2xl font-black py-6 px-16 rounded-3xl shadow-[0_8px_0_rgb(180,83,9)] active:shadow-none active:translate-y-2 transition-all flex items-center gap-3"
              >
                <Play fill="currentColor" className="w-8 h-8" /> PLAY
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* The Pile */}
        <div className="relative flex items-center justify-center" style={{ width: LEVEL_CONFIG.gridSize, height: LEVEL_CONFIG.gridSize }}>
          <AnimatePresence>
            {boardItems.map((item) => (
              <Tile
                key={item.id}
                item={item}
                isCovered={coveredStatus[item.id]}
                onClick={() => handleTileClick(item)}
              />
            ))}
          </AnimatePresence>
        </div>

        {/* Win/Loss Modal */}
        <AnimatePresence>
          {(gameState === 'won' || gameState === 'lost') && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md p-4"
            >
              <motion.div 
                initial={{ scale: 0.8, y: 50 }}
                animate={{ scale: 1, y: 0 }}
                className="bg-white p-8 rounded-[2rem] shadow-2xl max-w-sm w-full text-center border-8 border-amber-200"
              >
                <div className="text-7xl mb-4">
                  {gameState === 'won' ? '🏆' : '🐔'}
                </div>
                <h2 className="text-4xl font-black text-slate-800 mb-2 tracking-tight">
                  {gameState === 'won' ? 'NAILED IT!' : 'OOPS!'}
                </h2>
                
                <div className="min-h-[80px] mb-8 flex items-center justify-center bg-amber-50 rounded-xl p-4 border-2 border-amber-100">
                  {loadingCommentary ? (
                    <div className="flex gap-2 items-center text-amber-400 text-sm font-bold">
                      <Sparkles className="w-4 h-4 animate-spin" /> Gemini is cooking...
                    </div>
                  ) : commentary ? (
                    <p className="text-lg font-bold leading-snug text-amber-800">
                      "{commentary.text}"
                    </p>
                  ) : (
                     <p className="text-slate-400 text-sm">Ready for another round?</p>
                  )}
                </div>

                <button
                  onClick={startGame}
                  className="w-full bg-amber-500 hover:bg-amber-600 text-white text-xl font-bold py-4 rounded-2xl shadow-[0_6px_0_rgb(180,83,9)] active:shadow-none active:translate-y-[6px] transition-all flex items-center justify-center gap-2"
                >
                  <RotateCcw className="w-6 h-6" /> TRY AGAIN
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* The Dock */}
      <div className="pb-8 pt-2 px-4 flex justify-center z-40">
        <div className={`
            relative p-3 bg-amber-200 rounded-2xl border-b-8 border-amber-300 shadow-xl
            flex justify-center transition-colors duration-300
            ${gameState === 'lost' ? 'bg-red-200 border-red-300' : ''}
        `}>
            {/* Dock Slots (Background Layer) */}
            <div className="flex gap-2 md:gap-3">
                {Array.from({ length: DOCK_CAPACITY }).map((_, i) => (
                    <div key={i} className="w-11 h-11 md:w-14 md:h-14 bg-black/10 rounded-lg shadow-inner" />
                ))}
            </div>

            {/* Dock Items (Foreground Layer) */}
            <div className="absolute inset-0 flex items-center justify-center gap-2 md:gap-3 pointer-events-none">
                <AnimatePresence mode="popLayout">
                    {dock.map((item) => (
                         <div key={item.id} className="w-11 md:w-14 flex justify-center pointer-events-auto">
                            <DockTile item={item} />
                         </div>
                    ))}
                </AnimatePresence>
            </div>
            
            {/* Full Warning */}
            {dock.length >= DOCK_CAPACITY - 1 && gameState === 'playing' && (
                 <motion.div 
                   initial={{ scale: 0 }} animate={{ scale: 1 }}
                   className="absolute -top-4 right-0 bg-red-500 text-white text-xs font-bold px-3 py-1 rounded-full shadow-md border-2 border-white animate-pulse"
                 >
                   FULL!
                 </motion.div>
            )}
        </div>
      </div>

    </div>
  );
};

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
