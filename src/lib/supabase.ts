import { createClient } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabasePublishableKey, supabaseUrl } from './supabaseConfig'
import { friendlyError } from '../components/UserFeedback'

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabasePublishableKey!, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    })
  : null

export async function checkSupabaseConnection() {
  if (!supabase) return { connected: false, message: 'Supabase environment variables are missing.' }

  const { error } = await supabase.from('profiles').select('id').limit(1)
  if (error) return { connected: false, message: friendlyError(error, 'Supabase is not responding. Check your connection and try again.') }

  return { connected: true, message: 'Supabase API and profiles table are reachable.' }
}
