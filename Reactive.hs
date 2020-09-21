{-# LANGUAGE GeneralizedNewtypeDeriving #-}

module Reactive 
  (
    Stream (..)
  , joinS 
  , runS 
  , run
  , liftS
  , firstS
  , leftApp
  , broadcast_
  , broadcast
  , receive
  , multicast
  , interval
  , interval'
  , accumulate
  , foldS
  , countS
  , untilS
  , appS
  , reactimate
  , reactimateB
  , stepper
  , fetchG
  , fetchS
  , speedS
  , requestS
  , push2pull
  , takeS
  , foreverS
  , stopS
  , zipS
  , fromList
  , zipWithIndex
  , controlS
  , mergeS
  ) where

import Control.Monad (join)
import Control.Monad.Reader (ReaderT (..))
import Control.Monad.Cont (liftIO)
import AsyncM (AsyncM (..), ifAliveM, raceM, runM_, timeout, neverM, forkM, advM, commitM, cancelM, scopeM, unscopeM, allM, anyM)
import Emitter (Emitter (..), emit, listen, newEmitter_, spawnM)
import Progress (Progress (..), cancelP)
import Control.Monad.IO.Class (MonadIO)
import Control.Concurrent.Chan (newChan, readChan, writeChan)
import Control.Concurrent.Async (async, wait)
import Control.Concurrent (threadDelay, newMVar, takeMVar, putMVar, readMVar, swapMVar)
import Data.Maybe (fromJust)

type Time = Int

data Stream a = Next (Maybe a) (AStream a)  
              | End (Maybe a)

type AStream a = AsyncM (Stream a)

-----------------------------------------------------------------------

instance MonadIO Stream where
  liftIO a = Next Nothing (do x <- liftIO a 
                              return $ pure x)

instance Functor Stream where
  fmap f (Next a m) = Next (f <$> a) (fmap f <$> m)
  fmap f (End a) = End (f <$> a)

instance Applicative Stream where
  pure x = End (Just x)

  sf <*> sx = do f <- sf
                 x <- sx
                 return $ f x

instance Monad Stream where
  return = pure
  s >>= k = joinS $ fmap k s

joinS :: Stream (Stream a) -> Stream a
joinS (End Nothing)  = End Nothing
joinS (End (Just s)) = s
joinS (Nothing `Next` mss) = Nothing `Next` (joinS <$> mss)
joinS ( Just s `Next` mss) = s `switchS` mss

switchS :: Stream a -> AStream (Stream a) -> Stream a
switchS (a `Next` ms) mss = a `Next` (h ms =<< spawnM mss)
  where h ms mss = do
          r <- anyM mss (unscopeM ms)
          return $ case r of Left ss -> joinS ss
                             Right (End a) -> a `Next` (joinS <$> mss)
                             Right (a `Next` ms') -> a `Next` h ms' mss 
switchS (End a) mss = a `Next` (joinS <$> mss)
          

-----------------------------------------------------------------------

liftS :: AsyncM a -> Stream a
liftS m = Next Nothing (m >>= return . pure)

-- run the input stream until the first Just event is emitted
firstS :: Stream a -> Stream a
firstS (End x) = End x
firstS (Next Nothing ms) = Next Nothing (firstS <$> ms)
firstS (Next (Just x) _) = End (Just x)

leftApp :: Stream (a -> b) -> Stream a -> Stream b
leftApp sf sx = sf <*> firstS sx


-----------------------------------------------------------------------

runS :: Stream a -> (a -> IO ()) -> AsyncM ()
runS (End Nothing) _  = return ()
runS (End (Just x)) k = ifAliveM >> liftIO (k x)
runS (Next a ms) k = do ifAliveM
                        liftIO $ maybe (return ()) k a 
                        ms >>= flip runS k  

run :: Stream a -> (a -> IO ()) -> IO ()
run s k = runM_ (runS s k) return 

-- emit the first index after 1 ms delay
interval :: Int -> Int -> Stream Int
interval dt n = Next Nothing (timeout 1 >> h 1)
  where h x = if x >= n then return $ End (Just x)
              else do ifAliveM
                      return $ Next (Just x) (timeout dt >> h (x+1))

broadcast_ :: Stream a -> AsyncM (Emitter a, Progress)
broadcast_ s = do 
     e <- liftIO newEmitter_ 
     p <- forkM $ runS s $ emit e 
     return (e, p)

broadcast :: Stream a -> AsyncM (Emitter a)
broadcast s = fst <$> broadcast_ s

receive :: Emitter a -> Stream a
receive e = Next Nothing h
  where h = do a <- listen e
               ifAliveM
               return $ Next (Just a) h

multicast_ :: Stream a -> Stream (Stream a, Progress)
multicast_ s = Nothing `Next` do (e, p) <- broadcast_ s
                                 return $ pure (receive e, p)

multicast :: Stream a -> Stream (Stream a)
multicast s = fst <$> multicast_ s 

-----------------------------------------------------------------------

            
appS :: Stream (a -> b) -> Stream a -> Stream b
appS (Next f msf) (Next x msx) = Next (f <*> x)  
  (do mf <- spawnM msf
      mx <- spawnM msx
      anyM mf mx >>= either (\sf -> return $ appS sf $ Next x mx)
                            (\sx -> return $ appS (Next f mf) sx) 
  )
appS (End f) (End x) = End (f <*> x)
appS (End f) (Next x msx) = Next (f <*> x) (appS (End f) <$> msx)
appS (Next f msf) (End x) = Next (f <*> x) (flip appS (End x) <$> msf)


mergeS :: Stream a -> Stream a -> Stream a
mergeS (Next a ma) (Next b mb) = Next a $ return (Next b $ h ma mb)
  where h ma mb = do ma' <- spawnM ma
                     mb' <- spawnM mb
                     anyM ma' mb' >>= either (\(Next a ma) -> return $ Next a $ h ma mb')
                                             (\(Next b mb) -> return $ Next b $ h ma' mb) 

mergeS (End a) (End b) = Next a (return $ End b)
mergeS (End a) s = Next a $ return s
mergeS (Next a msa) (End b) = Next a $ return (Next b msa)


-----------------------------------------------------------------------

zipS :: Stream a -> Stream b -> Stream (a, b)
zipS (End a1) (End a2) = End (pure (,) <*> a1 <*> a2)
zipS (End a1) (Next a2 ms2) = End (pure (,) <*> a1 <*> a2)
zipS (Next a1 ms1) (End a2) = End (pure (,) <*> a1 <*> a2)
zipS (Next a1 ms1) (Next a2 ms2) = Next (pure (,) <*> a1 <*> a2) ms 
  where ms = do (s1, s2) <- allM ms1 ms2
                ifAliveM
                return $ zipS s1 s2

repeatS :: AsyncM a -> Stream a
repeatS m = Next Nothing (repeatA m)

repeatA :: AsyncM a -> AStream a
repeatA m = do a <- m
               ifAliveM
               return $ Next (Just a) (repeatA m)

foreverS :: Int -> Stream ()
foreverS dt = repeatS $ timeout dt

fromList :: [a] -> Stream a
fromList [] = End Nothing 
fromList (a:t) = Next (Just a) (return $ fromList t)

zipWithIndex :: Stream a -> Stream (Int, a)
zipWithIndex s = zipS (fromList [1..]) s

-- get rid of Nothing except possibly the first one
justS :: Stream a -> Stream a
justS (End a) = End a
justS (Next a ms) = Next a (ms >>= h)
  where h (Next Nothing ms) = ms >>= h
        h (Next (Just x) ms) = return $ Next (Just x) (ms >>= h)
        h (End a) = return $ End a

-- take the first n events. If n <= 0, then nothing
-- if 's' has less than n events, the 'takeS n s' emits all events of s
takeS :: Int -> Stream a -> Stream a
takeS n s = if n <= 0 then End Nothing else f n (justS s)  
  where f n (Next a ms) = Next a (scopeM $ h (n-1) ms)
        f _ (End a) = End a
        h 0 ms = cancelM >> return (End Nothing)
        h n ms = do s <- ms
                    case s of Next a ms' -> return $ Next a (h (n-1) ms')
                              End a -> return (End a)

-- drop the first n events
-- if 's' has less than n events, then 'dropS s' never starts.
dropS :: Int -> Stream a -> Stream a
dropS n s = justS (h n s)
  where h n s | n <= 0 = s 
              | otherwise = case s of End _ -> End Nothing
                                      Next _ ms -> Next Nothing (h (n-1) <$> ms)

-- wait dt milliseconds and then start 's'
waitS :: Time -> Stream a -> Stream a
waitS dt s = Next Nothing (timeout dt >> return s)

-- skip the events of the first dt milliseconds  
skipS :: Time -> Stream a -> Stream a
skipS dt s = do s' <- multicast s 
                waitS dt s'

-- delay each event of 's' by dt milliseconds
delayS :: Time -> Stream a -> Stream a
delayS dt s = Next Nothing (h s)
  where h (Next a ms) = timeout dt >> (return $ Next a (ms >>= h))
        h (End a) = timeout dt >> (return $ End a)

-- stop 's' after dt milliseconds
stopS :: Time -> Stream a -> Stream a
-- stopS dt s = s `untilS` (timeout dt >> return (End Nothing))
stopS _ (End a) = End a
stopS dt s = s `switchS` (timeout dt >> return (End Nothing))

-- start the first index after dt
interval' dt n = takeS n $ fmap fst $ zipWithIndex $ foreverS dt

-----------------------------------------------------------------------

-- fold the functions emitted from s with the initial value a
accumulate :: a -> Stream (a -> a) -> Stream a
accumulate a (Next f ms) = let a' = maybe a ($ a) f  
                           in Next (Just a') (accumulate a' <$> ms)
accumulate a (End f) = End (Just $ maybe a ($ a) f) 

lastS :: Stream a -> AsyncM () -> AsyncM (Maybe a)
lastS s m = spawnM m >>= flip h s
  where h m (Next a ms) = anyM ms m >>= either (h m) (\() -> return a) 
        h m (End a) = m >> return a

-- fold the functions emitted from s for n milli-second with the initial value c 
foldS :: Time -> a -> Stream (a -> a) -> AsyncM a
foldS n c s = fromJust <$> lastS (accumulate c s) (timeout n) 

-- emit the number of events of s for every n milli-second
countS :: Time -> Stream b -> AsyncM Int
countS n s = foldS n 0 $ (+1) <$ s 

-- run s until ms occurs and then runs the stream in ms
untilS :: Stream a -> AStream a -> Stream a
untilS s ms = joinS $ Next (Just s) (pure <$> ms)

-----------------------------------------------------------------------

-- fetch data by sending requests as a stream of AsyncM and return the results in a stream
fetchS :: Stream (AsyncM a) -> Stream a
fetchS sm = Next Nothing $ do c <- liftIO newChan
                              forkM $ runS (sm >>= liftS . spawnM) (writeChan c)  
                              repeatA $ join $ liftIO (readChan c) 

-- measure the data speed = total sample time / system time
speedS :: Time -> Stream (Time, a) -> AsyncM Float
speedS n s = f <$> (foldS n 0 $ (\(dt,_) t -> t + dt) <$> s)
  where f t = fromIntegral t / fromIntegral n

-- call f to request samples with 'dt' interval and 'delay' between requests
requestS :: (Time -> AsyncM a) -> Time -> Time -> Stream (Time, a)
requestS f dt delay = (,) dt <$> s
  where s = fetchS $ f dt <$ foreverS delay

controlS :: (t -> Stream (AsyncM a)) -> Int -> t -> (Bool -> t -> t) -> Stream (t, a) 
controlS req_fun duration dt adjust = join $ h dt  
  where h dt = do (request,  p1) <- multicast_ $ req_fun dt 
                  (response, p2) <- multicast_ $ fetchS request 
     
                  let mss = do timeout duration 
                               (x, y) <- allM (countS duration response)
                                              (countS duration request)
                               liftIO $ print(x, y)
                               if x == y then mss
                               else do liftIO $ cancelP p1 >> cancelP p2
                                       return $ h $ adjust (x < y) dt 
                  Just ((,) dt <$> response) `Next` mss

-----------------------------------------------------------------------

-- Pull-based stream
newtype Signal m a = Signal { runSignal ::  m (a, Signal m a) }

instance (Monad m) => Functor (Signal m) where
  fmap f (Signal m) = Signal $ do (a, s) <- m 
                                  return (f a, fmap f s)

instance (Monad m) => Applicative (Signal m) where
  pure a = Signal $ return (a, pure a)
 
  Signal mf <*> Signal mx = 
       Signal $ do (f, sf) <- mf
                   (x, sx) <- mx 
                   return (f x, sf <*> sx)

-- buffer events from stream s as a signal
push2pull :: Stream a -> AsyncM (Signal IO a)
push2pull s =  do 
     c <- liftIO newChan
     forkM $ runS s $ writeChan c 
     let f = do a <- readChan c
                return (a, Signal f)
     return $ Signal f

-- run k for each event of the signal s
bindG :: Signal IO a -> (a -> IO b) -> Signal IO b
bindG s k = Signal $ do 
     (a, s') <- runSignal s
     b <- k a
     return (b, bindG s' k)

-- fetch data by sending requests as a stream and return the results in the order of the requests
fetchG :: Stream (AsyncM a) -> AsyncM (Signal IO a)
fetchG s = push2pull $ fetchS s

-- run signal with event delay
reactimate :: Time -> Signal IO a -> Stream a
reactimate delay g = Next Nothing (h g)
  where h g = do timeout delay
                 ifAliveM
                 (a, g') <- liftIO $ runSignal g 
                 return $ Next (Just a) (h g')

-----------------------------------------------------------------------

-- Event is a signal of delta-time and value pairs
type Event a = Signal IO (Time, a)

-- Behavior is a signal of delta-time to value functions
type Behavior a = Signal (ReaderT Time IO) a

-- make an event out of a stream of AsyncM
fetchE :: Time -> (Time -> Stream (AsyncM a)) -> AsyncM (Event a)
fetchE dt k = push2pull $ fetchES dt k

fetchES :: Time -> (Time -> Stream (AsyncM a)) -> Stream (Time, a)
fetchES dt k = (,) dt <$> (fetchS $ k dt)

-- a behavior that synchronously fetches data, which is blocking and will experience all IO delays
fetchB :: (Time -> IO a) -> Behavior a
fetchB k = Signal $ ReaderT $ \t -> do a <- k t
                                       return (a, fetchB k)

-- Converts an event signal to a behavior signal 
-- downsample by applying the summary function
-- upsample by repeating events
stepper :: ([(Time, a)] -> a) -> Event a -> Behavior a
stepper summary ev = Signal $ ReaderT $ \t -> h [] t ev
 where h lst t ev = do 
         ((t', a), ev') <- runSignal ev   
         if (t == t') then return (f ((t,a):lst), stepper summary ev') 
         else if (t < t') then return (f ((t,a):lst), stepper summary $ Signal $ return ((t'-t, a), ev'))
         else h ((t',a):lst) (t-t') ev' 
       f [(t,a)] = a
       f lst = summary lst 
     
-- run behavior with event delay and sample delta-time
reactimateB :: Time -> Time -> Behavior a -> Stream (Time, a)
reactimateB delay dt g = Next Nothing (h g)
  where h g = do timeout delay
                 ifAliveM
                 (a, g') <- liftIO $ (runReaderT $ runSignal g) dt 
                 return $ Next (Just (dt, a)) (h g')

-- convert event of batches into event of samples
unbatch :: Event [a] -> Event a
unbatch eb = Signal $ do
     ((dt, b), eb') <- runSignal eb
     h dt b eb'
  where h _ [] eb' = runSignal $ unbatch eb'
        h dt (a:b) eb' = return ((dt, a), Signal $ h dt b eb') 

-- convert behavior to event of batches of provided size and delta-time
batch :: Time -> Int -> Behavior a -> Event [a]
batch dt size g = Signal $ h [] size g
  where h b n g
         | n <= 0 = return ((dt, b), batch dt size g)
         | otherwise = do (a, g') <- (runReaderT $ runSignal g) dt
                          h (b++[a]) (n-1) g'

-- factor >= 1
upsample :: Int -> Behavior a -> Behavior [a]
upsample factor b = Signal $ ReaderT $ \t -> 
  do (a, b') <- runReaderT (runSignal b) (factor * t)
     return $ (take factor $ repeat a, upsample factor b')

-- downsample a behavior with a summary function
-- since dt is Int, downsampling factor may not be greater than dt
downsample :: Int -> ([(Int, a)] -> a) -> Behavior a -> Behavior a
downsample factor summary b = Signal $ ReaderT $ \t -> 
  let t' = if t <= factor then 1 else t `div` factor 
      h 0 lst b = return (summary lst, downsample factor summary b)
      h n lst b = do (a, b') <- runReaderT (runSignal b) t'
                     h (n-1) ((t',a):lst) b' 
  in h factor [] b   

-- Do NOT unbatch windowed data since the sampling time is dt*stride.
-- convert a behavior into event of sample windows of specified size, stride, and sample delta-time
-- resulting delta-time is 't * stride'
window :: Int -> Int -> Time -> Behavior a -> Event [a]
window size stride t b = Signal $ init size [] b
  where init 0 lst b = step 0 lst b
        init s lst b = do (a, b') <- (runReaderT $ runSignal b) t
                          init (s-1) (lst++[a]) b'
        step 0 lst b = return ((t*stride, lst), Signal $ step stride lst b)
        step d lst b = do (a, b') <- (runReaderT $ runSignal b) t
                          step (d-1) (tail lst ++ [a]) b'


