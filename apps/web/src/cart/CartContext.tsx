import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ShoppingCart } from '@spectra/contracts';
import { useAuth } from '../auth/AuthContext.js';
import { addCartItem, CartApiError, getCart, removeCartItem, updateCartItem } from './cart-api.js';

interface CartState {
  cart: ShoppingCart | undefined;
  loading: boolean;
  message: string;
  add: (productId: string, quantity: number) => Promise<void>;
  update: (itemId: string, quantity: number) => Promise<void>;
  remove: (itemId: string) => Promise<void>;
  reload: () => Promise<void>;
}

const Context = createContext<CartState | undefined>(undefined);

export function CartProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [cart, setCart] = useState<ShoppingCart>();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  async function load(signal?: AbortSignal): Promise<void> {
    if (user?.role !== 'CLIENTE') {
      setCart(undefined);
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      setCart(await getCart(signal));
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setMessage(error instanceof Error ? error.message : 'No fue posible cargar el carrito');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [user?.id, user?.role]);

  async function apply(operation: () => Promise<ShoppingCart>): Promise<void> {
    setMessage('');
    try {
      setCart(await operation());
    } catch (error: unknown) {
      const caught = error instanceof CartApiError ? error : undefined;
      setMessage(caught?.message ?? 'No fue posible actualizar el carrito');
      throw error;
    }
  }

  const value = useMemo<CartState>(
    () => ({
      cart,
      loading,
      message,
      add: (productId, quantity) => apply(() => addCartItem(productId, quantity)),
      update: (itemId, quantity) => apply(() => updateCartItem(itemId, quantity)),
      remove: (itemId) => apply(() => removeCartItem(itemId)),
      reload: () => load(),
    }),
    [cart, loading, message, user?.id, user?.role],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useCart(): CartState {
  const value = useContext(Context);
  if (!value) throw new Error('useCart requiere CartProvider');
  return value;
}
