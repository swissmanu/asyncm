
/*
 *  1. utility definitions: unit, Maybe, and Either
 */

const unit = undefined;

/*
 * Maybe type
 */
class Nothing {
	maybe = nothing => _ => nothing
	fmap = _ => this
	app = _ => this
}

class Just {
	constructor(value) { this.value = value; }
	maybe = _ => just => just(this.value) 
	fmap = f => Maybe.just(f(this.value))
	app = maybeX => maybeX.fmap(this.value)
	fromJust = _ => this.value
}

const Maybe = { 
	nothing : new Nothing (), 
	just : x => new Just (x), 
	pair : a => b => new Just (x=>y=>[x,y]).app(a).app(b) 
};

/*
 * Either type
 */

class Either {
	constructor(value) { this.value = value; }
	static left = x => new Left(x)
	static right = x => new Right(x)
};

class Left extends Either { either = l => _ => l(this.value); }

class Right extends Either { either = _ => r => r(this.value); }


/*
 *  2. Progress definitions: Progress, ConsP, and NilP
 */

class Progress {
	constructor() {
		this.head = false;
	}
	static nil () { return new NilP(); }

	cons () { return new ConsP(this); }

	cancelP () { if (! this.head) { this.head = true; return true; } else { return false; } }
}

class ConsP extends Progress {
	constructor(tail) {
		super();
		this.tail = tail;
	}
	isAliveP () { 
		if (!this.head) { return this.tail.isAliveP(); }
		else return false;
	}
}

class NilP extends Progress {
	isAliveP () { return !this.head; }
}

/*
 *  3. AsyncM definitions: AsyncM, never, timeout, cancel, ifAlive, commit, race, any, all 
 */

class AsyncM {
	// run :: Progress -> (a -> IO ()) -> IO ()
	// run :: Progress -> Promise a 
	constructor (run) {
		this.run = run;
	}

	// f <$> this
	fmap = f => new AsyncM (p => this.run(p).then(x => f(x))); 

	// this >>= f
	bind = f => new AsyncM (p => this.run(p).then(x => f(x).run(p))); 

	// flatten an AsyncM of AsyncM
	join = _ => this.bind(m => m)

	// this <*> mx
	app = mx => this.bind(f => mx.bind(x => AsyncM.pure(f(x))))

	// return an AsyncM of AsyncM to wait for the result of 'this'
	//
	// AsyncM a -> AsyncM (AsyncM a)
	spawn = _ => new SpawnM (async p => {
			const e = new Emitter();
			this.run(p).then(x => e.emit(x));
			return e.wait();
		     });

	// run 'this' without waiting for it to complete and return its progress for later cancellation
	fork = _ => new AsyncM (async p => {
			const p1 = p.cons();
			this.run(p1); 
			return p1; 
		    })

	// run 'this' under a nested progress
        scope = _ => new AsyncM ( p => this.run(p.cons()) )

	// run 'this' under the parent progress
        unscope = _ => new AsyncM ( p => this.run(p.tail == undefined ? p : p.tail) )

	// lift AsyncM to a stream
	liftS = _ => Stream.next(Maybe.nothing, this.bind(x => AsyncM.pure(Stream.pure(x))))

	// repeat 'AsyncM a' as 'Stream a'
	repeatS = _ => Stream.next(Maybe.nothing, this.repeatA())


	// repeat 'AsyncM a' as 'AsyncM (Stream a)'
	repeatA = _ => this.bind(a => 
			AsyncM.ifAlive.bind(_ => 
				AsyncM.pure(Stream.next(Maybe.just(a), this.repeatA()))))

	// pure value as AsyncM
	static pure = x => new AsyncM ( p => Promise.resolve(x) )  

	// lift an IO to an AsyncM -- 'io' takes a continuation k and calls k with its result.
	//
	// liftIO :: ((a -> IO ()) -> IO ()) -> AsyncM a
        static liftIO = io => new AsyncM (p => new Promise(io)) 

	// lift a promise to an AsyncM
	//
	// liftIO :: Promise a -> AsyncM a
        static liftIO_ = io => new AsyncM (p => io) 

	// an AsyncM that never completes -- no longer useful
	static never = new AsyncM (p => new Promise (_=>{}))

	// completes after 'n' millisecond timeout
	static timeout = n => new AsyncM (p => new Promise (k => setTimeout(k, n)))

	// cancel the current progress
	static cancel = new AsyncM (p => new Promise(k => { if (p.cancelP()) k(); }));

	// continues only if 'p' is still alive
	//
	// () => k() simulates the IO that k returns
	static ifAlive = new AsyncM (p => new Promise(k => { if (p.isAliveP()) k(); }));

	// if alive, then cancel
	static commit = AsyncM.ifAlive.bind(_ => AsyncM.cancel);

	// run two AsyncM with a new progress
	static race = (m1) => (m2) => new AsyncM (p => new Promise (k => {
		m1.run(p).then(k);
		m2.run(p).then(k); 
	})).scope();

	// race two AsyncM where the winner cancels the progress before returning its results
	static any = (m1) => (m2) => AsyncM.race 
		(m1.bind(x1 => AsyncM.commit.bind(_ => AsyncM.pure(Either.left(x1))))) 
	        (m2.bind(x2 => AsyncM.commit.bind(_ => AsyncM.pure(Either.right(x2)))))

	// run two AsyncM and wait for both of their results
	static all = (m1) => (m2) => new AsyncM (p => Promise.all([m1.run(p), m2.run(p)]));

	/*
 	 * for testing purpose only 
 	 */
	static interval = (n, dt, f) => {
		const h = i => AsyncM.ifAlive.bind(_ => new AsyncM(async p => {
			if (i <= n) {
				return AsyncM.timeout(dt)
				.bind(_ => AsyncM.liftIO(k => k(f(i))).bind(_ => h(i+1)))
				.run(p);
		}}));
		return h(1);
	}
}

/*
 * A hack to avoid making a chain of spawned AsyncMs (only a problem in 'combineLatest'), 
 * which can leads to stack overflow for an event that rarely occurs.
 */
class SpawnM extends AsyncM { spawn = _ => this }


/*
 *  4. Emitter definition
 */

class Emitter {
	constructor() {
		this.now = undefined;  // current event
		this.listeners = [];   // blocked listeners
	}

	// emit an event to this emitter and wait up any pending listeners
	emit (x) {
		this.now = x;
		const l = this.listeners;
		this.listeners = [];
		const len = l.length;

		for(let i = 0; i < len; i++ ) { l[i](x); }
	}

	// listen for the next event as an AsyncM
	listen = () => new AsyncM (p => new Promise (k => { this.listeners.push(k); }))

	// return the current event or wait for the future one
	wait = () => new AsyncM (p => new Promise (k => {
			if (this.now != undefined) { k(this.now); }
			else { 
				// only keep one listeners
				this.listeners = [k]; 
			}
	}));

	// listen to the future events as a stream
	receive = _ => {
		const h = _ => this.listen()
			           .bind(a => AsyncM.ifAlive.bind(_ => 
					   AsyncM.pure (Stream.next(Maybe.just(a), h()))
				   ));
		return Stream.next(Maybe.nothing, h()); 
	}
}


/*
 *  5. Channel definition
 */

class Channel {
	constructor() {
		this.data = [];			// data buffer
		this.listeners = [];		// reader queue
	}

	// read :: (a -> IO()) -> IO()
	// read :: Promise a
	read = _ => new Promise (k => {
		const d = this.data;
		if(d.length > 0) { 
			k(d.shift()); 		// read one data
		} else { 
			this.listeners.push(k); // add reader to the queue
		}
	});

	// write :: a -> IO()
	write = x => {
		const l = this.listeners;
		if(l.length > 0) {
			const k = l.shift(); 	// wake up one reader in FIFO order
			k(x);
		}
		else {
			this.data.push(x); 	// buffer if no reader in the queue
		}
	}
}


/*
 *  6. Stream definition: use 'match' method to simulate pattern matching on End and Next cases
 */

class Stream { 
	constructor(a) { this.maybe_a = a; }

 	// run 's' by calling 'k' for each event of 'this' stream	
	run = k => AsyncM.ifAlive.bind(_ => 
		this.match (a => AsyncM.liftIO(k1 => k1(a.maybe (unit) (k))))
	              ((a, m) => AsyncM.liftIO(k1 => k1(a.maybe (unit) (k))).bind(_ => m.bind(s => s.run(k))))
	)

	// f <$> s
	fmap = f => this.match (a => Stream.end (a.fmap(f)))
	                  ((a, m) => Stream.next(a.fmap(f), m.fmap(s => s.fmap(f))))

	// sf <*> sx
	app = sx => this.bind(f => sx.bind(x => Stream.pure(f(x))))

	// s >>= f
	bind = k => this.match (a => a.maybe (this) (k))
	                       (_ => this.fmap(k).join())

	// flatten a stream of streams
	join = () => this.match (a => a.maybe (this) (s => s)) 
	                   ((a, m) => a.maybe (Stream.next(Maybe.nothing, m.fmap(ss => ss.join()))) (s => s.switchS(m)))

	// switch 'this' stream on future stream of streams 'mss' -- usage: s.switchS(mss) 
	switchS = mss => {
        	const h = ms => mss => AsyncM.any(mss)(ms.unscope()).fmap(r => 
				r.either(ss => ss.join()) 
					(s => s.match (a => Stream.next(a, mss.fmap(ss => ss.join())))
	                           	   	 ((a, m) => Stream.next(a, h(m)(mss))))
		);
		
		return this.match (a => Stream.next(a, mss.fmap(ss => ss.join())))
	                     ((a, m) => Stream.next(a, mss.spawn().bind(mss1 => h(m)(mss1)))) 
	}

	// take a snapshot of the right stream 'sx' for each left stream event 'f' and return 'f x' as a stream
	leftApp = sx => {
		// run 's' until it emits the first 'Just' event 
		const h = s => s.match (_ => s)
		                  ((a, m) => a.maybe (Stream.next(Maybe.nothing, m.fmap(h))) (x => Stream.end(Maybe.just(x))))
		
		return this.app(h(sx))
	}

	// broadcast the events of 'this' stream to an emitter 'e' 
	// and return [e, p], where 'p' is the progress for cancellation
	broadcast = _ => AsyncM.liftIO(k => k(new Emitter()))
			 .bind(e => this.run(x => e.emit(x))
				        .fork()
				        .bind(p => AsyncM.pure([e,p])))

	// make a shareable stream and the associated progress
	multicast_ = _ => Stream.next(Maybe.nothing, 
		                     this.broadcast()
		                         .bind(([e,p]) => AsyncM.pure(Stream.pure([e.receive(), p]))))
	
	// only return the shareable stream
	multicast = _ => this.multicast_().fmap(([s,_]) => s)

	// apply each event in 'this' to each event in 'sx'
	combineLatest = sx => {
	  const _appF = sf => sx => sf.match (f => _appX(f)(sx))
	 		               ((f, mf) => _appFX(f, mf)(sx))

	  const _appX = f => sx => sx.match (x => Stream.end (f.app(x)))
	                              ((x, mx) => Stream.next(f.app(x), mx.fmap(sx => _appX(f)(sx))))

	  const _appFX = (f, mf) => sx => sx.match
		(x => Stream.next(f.app(x), mf.fmap(sf => _appF(sf)(sx)))) 
          ((x, mx) => Stream.next(f.app(x),  
		           mf.spawn().bind(mf1 => 
			   mx.spawn().bind(mx1 =>
			  AsyncM.any(mf1)(mx1).bind(r => AsyncM.pure(
				  r.either(sf => _appF(sf)(Stream.next(x, mx1)))
			                  (sx => _appFX(f, mf1)(sx))
			  ))))))

	  return _appF(this)(sx);
	}

	// zip 'this' with 'that' streams as a stream of pairs -- some events may be lost 
	zip = that => this.match(a1 => that.match(a2      => Stream.end (Maybe.pair(a1)(a2)))
		       	  	   	   	((a2, _)  => Stream.end (Maybe.pair(a1)(a2))))
	 	     	  ((a1, m1) => that.match(a2      => Stream.end (Maybe.pair(a1)(a2)))
		        	   	   	((a2, m2) => Stream.next(Maybe.pair(a1)(a2), 
				  AsyncM.all(m1)(m2).bind(([s1,s2]) => 
					  AsyncM.ifAlive.bind(_ => 
						  AsyncM.pure(s1.zip(s2)))))))

	// zip a stream with indices starting from 'i'
	zipWithIndex = i => this.match(a => Stream.end (a.fmap(a => [i,a])))
			         ((a, m) => Stream.next(a.fmap(a => [i,a]), m.fmap(s => s.zipWithIndex(i+1))))

	// cancel the progress of a stream after reaching its end
	end = _ => {
		const h = s => s.match
			(_ => AsyncM.cancel.bind(_ => AsyncM.pure(s)))
		   ((a, m) => AsyncM.pure(Stream.next(a, m.bind(h))))

		return this.match (_ => this)
	                     ((a, m) => Stream.next(a, m.bind(h).scope())); 
	}

	// take n events (Nothing does not count)
	take = n => (n <= 0) 
		  ? Stream.end(Maybe.nothing) 
		  : this.match (_ => this)
	 	          ((a, m) => (n <= 1 && a != Maybe.nothing) 
				   ? Stream.end(a) 
				   : Stream.next(a, this.next.fmap(s => s.take(a.maybe(n)(_ => n-1)))))

	// take n events and then cancel the progress
	take_ = n => this.take(n).end()

	// drop n events (Nothing does not count)
	drop = n => {
	  	const h = n => s => (n <= 0) 
		  ? s
		  : s.match (_ => Stream.end(Maybe.nothing))
	               ((a, m) => Stream.next(Maybe.nothing, m.fmap(s => h(a.maybe(n)(_=>n-1))(s))))

		return h(n)(this).just();
	}

	// omit the nothing events in a stream except the first one
	just = _ => { 
		const h = s => s.match (_ => AsyncM.pure(s))
			          ((a, m) => a.maybe (m.bind(h)) (x => AsyncM.pure(Stream.next(Maybe.just(x), m.bind(h)))))
		
		return this.match (_ => this) ((a, m) => Stream.next(a, m.bind(h)))
	}

	// wait 'dt' milliseconds before starting 'this' stream
	wait = dt => Stream.next(Maybe.nothing, AsyncM.timeout(dt).bind(_ => AsyncM.pure(this)))

	// skipping events of 'this' stream for 'dt' milliseconds
	skip = dt => Stream.next(Maybe.nothing, AsyncM.timeout(dt).spawn().bind(mt => { 
			const h = s => s.match (_ => AsyncM.pure(Stream.end(Maybe.nothing)))
					  ((_, m) => m.spawn().bind(ms => AsyncM.any(ms)(mt).bind(r => r.either(h)(_ => ms))))
			
			return this.next.bind(h);
		}))

	// delay each event in a stream by 'dt' milliseconds
	delay = dt => {
		const h = s => s.match (a => AsyncM.timeout(dt).fmap(_ => Stream.end(a)))
		   		  ((a, m) => AsyncM.timeout(dt).fmap(_ => Stream.next(a, m.bind(h))))

		return Stream.next(Maybe.nothing, h(s));
	}

	// stop after 'dt' millisecond
	stop = dt => this.match (_ => this) 
	                        (_ => this.switchS(AsyncM.timeout(dt).fmap(_ => Stream.end(Maybe.nothing))))

	// fold the functions in 'this' stream with an initial value 'a0' 
	// and output the result of each fold as a stream
	accumulate = a0 => this.match (a => Stream.end(Maybe.just(a.maybe(a0)(f => f(a0))))) 
		                 ((a, m) => { 
					 const a1 = a.maybe(a0)(f => f(a0)); 
					 return Stream.next(Maybe.just(a1), m.fmap(s => s.accumulate(a1)));
		      		 })

	// return the last event of 'this' stream before 'm' emits
	last = m => m.spawn().bind(m1 => {
		const h = s => s.match (_ => AsyncM.pure(a))
		   	 	  ((a, m) => AsyncM.any(m)(m1).bind(r => r.either(h)(_ => AsyncM.pure(a))))
		return h(this)
	})

	// fold the functions of 'this' stream for 'n' milliseconds and return the final result
	fold = n => c => this.accumulate(c).last(AsyncM.timeout(n)).fmap(r => r.fromJust())

	// count the number of events in 'this' stream within 'n' milliseconds
	count = n => this.fmap(_ => c => c+1).fold(n)(0)

	// run 'this' stream until the future stream 'ms' emits its stream
	until = ms => Stream.next(Maybe.just(this), ms.fmap(s => Stream.pure(s))).join()

	// convert a stream of requests to a stream of responses
	//
	// fetch :: Stream (AsyncM a) -> Stream a
	fetch = _ => {
		const m = AsyncM.liftIO (k => k(new Channel())).bind(c => {
				const w = this.bind(m => m.spawn().liftS()).run(m1 => c.write(m1)).fork();
				// We don't use the progress 'p' here but do we need to cancel it later?
				return w.bind(p => AsyncM.liftIO(k => k(c.read())).join().repeatA());
		})

		return Stream.next(Maybe.nothing, m)
	}

	// return 'sum (dt) / n' after 'n' milliseconds, where 'this' is a stream of (dt, a) pairs 
	//
	// speed :: Stream (Time, a) -> Time -> AsyncM Float
	speed = n => this.fmap(([dt,_]) => t => t + dt).fold(n)(0).fmap(t => t/n)

	// test whether the speed should be adjusted after a 'duration' using the indicator function 'f'
	//
	// speedControl :: Stream (Time, a) -> Time -> (Double -> Int) -> AsyncM Bool
	// f(x) ==  0 means no change (right speed)
	// f(x) ==  1 means True (too fast)
	// f(x) == -1 means False (too slow)
	speedControl = duration => f => {
		const ms = AsyncM.timeout(duration).bind(_ =>
			this.speed(duration).bind(x => {
				// console.log(x); 
				const d = f(x)
				return (d == 0) ? ms : AsyncM.pure(d == 1);
			})
		)
		return ms;
	}

	// convert 'this' stream to a pull signal
	push2pull = _ => AsyncM.liftIO(k => k(new Channel())).bind(c => 
		this.run(x => c.write(x)).fork().bind(p => 
			AsyncM.pure(new Signal(_ => c.read()))
		)
	)

	// convert a stream of requests to a signal
	//
	// fetchG :: Stream (AsyncM a) -> AsyncM (Signal a)
	fetchG = _ => this.fetch().push2pull()

	static next = (a, m) => new Next(a, m)

	static end = a => new End(a)

	static pure = x => Stream.end(Maybe.just(x))

	// emits a number from 1 to n every 'dt' milliseconds 
	static interval = (dt, n) => {
		const h = x => (x >= n) ? AsyncM.pure(Stream.end(Maybe.just(x))) : 
			AsyncM.ifAlive.bind(_ => 
				AsyncM.pure(
					Stream.next(Maybe.just(x), 
						AsyncM.timeout(dt).bind(_=> h(x+1)))));

		return Stream.next(Maybe.nothing, AsyncM.timeout(0).bind(_ => h(1)));
	}

	// an indirect way to make an interval
	static interval_ = (dt, n) => Stream.forever(dt).zipWithIndex(0).fmap(([i,_])=>i).take(n)

	// emit unit every 'dt' millisecond forever.
	static forever = dt => AsyncM.timeout(dt).repeatS()

	// return a finite stream with elements in 'lst' 
	static fromList = lst => {
		if(lst.length == 0) { return Stream.End(Maybe.nothing); }
		else {
			[a,...b] = lst
			return Stream.next(Maybe.just(a), AsyncM.pure(Stream.fromList(b)));
		}
	}
	
	// converts a stream of requests (of the sampling period 'dt' and latency 'delay') to a stream of (dt, a) pairs
	//
	// request :: (Time -> AsyncM a) -> Time -> Time -> Stream (Time, a)
	static request = async_fun => dt => delay => 
		Stream.forever(delay).fmap(_ => async_fun(dt)).fetch().fmap(x => [dt, x])

	// control the speed of a stream of requests by adjusting the sampling rate 'dt' using the 'adjust' function
	//
	// control :: (t -> Stream (AsyncM a)) -> Int -> t -> (Bool -> t -> t) -> Stream (t, a) 
	static control = req_fun => duration => dt => adjust => {
		const h = dt => 
			req_fun(dt).multicast_().bind(([request, p1]) => 
			request.fetch().multicast_().bind(([response, p2]) => {
				const mss = AsyncM.timeout(duration).bind(_ => 
					AsyncM.all (response.count(duration)) (request.count(duration))
					.bind (([x,y]) => {
						// console.log(x,y); 
						if (x == y) { return mss; }
						else {
							p1.cancelP();
							p2.cancelP();
							return AsyncM.pure(h (adjust(x<y)(dt)));
						} 
					})
				);

				return Stream.next(Maybe.just(response.fmap(x => [dt, x])), mss);
			}));

		return h(dt).join(); 
	}

	// converts a  stream of requests (of the sampling period 'dt') to an Event Siganl
	//
	// fetchE  :: (Time -> Stream (AsyncM a)) -> Time -> AsyncM (Event a)
	static fetchE  = req_fun => dt => req_fun(dt).fetch().fmap(x => [dt. x]).push2pull()
}

class End extends Stream {
	constructor (a) { super(a); }

	// pattern match 'End' case
	match = f_end => _ => f_end(this.maybe_a)
}

class Next extends Stream { 
	constructor (a, m) {
		super(a);
		this.next = m;
	}

	// pattern match 'Next' case
	match = _ => f_next => f_next(this.maybe_a, this.next)
}


/*
 *  6. Signal definition: Signal (Event Signal) and Behavior 
 */

/*
 * The Signal class -- imperative implementation to reduce overhead
 *
 * The run function only passes the data 'a', not a pair (a, Signal a), to its callback parameter, 
 *
 * A signal object should be reused to generate the next value.
 */

class Signal {
	// run :: (a -> IO ()) -> IO ()
	// run :: _ -> Promise a
	constructor(run) { 
		this.run= run; 
	}

	static pure = a => new Signal(_ => Promise.resolve(a))

	// f <$> this
	fmap = f => new Signal(_ => this.run().then(f));

	// this <*> gx
	app = gx => new Signal(_ => Promise.all([this.run(), gx.run()]).then(([f,x]) => f(x)))

	// run a signal as a stream with added 'delay' between events
	reactimate = delay => {
		const h = AsyncM.timeout(delay).bind(_ => 
			AsyncM.ifAlive.bind(_ => 
				AsyncM.liftIO_(this.run()).bind(a => 
					AsyncM.pure(Stream.next(Maybe.just(a), h))
				)
			)
		)
		return Stream.next(Maybe.nothing, h)
	}

	// The following two methods only make sense for 'Signal (Time, a)' (i.e. 'Event a')

	// convert an Event Signal to a Behavior using a summary function 
	//
	// stepper :: Signal (Time, a) -> ([(Time, a)] -> a) -> Behavior a	
	stepper = summary => {
		let leftover = null;
		const f = lst => (lst.length == 1) ? lst[0][1] : summary(lst);

		const h = async dt => {
			let lst = [];

			if (leftover == null) { leftover = await this.run(); }
			let [dt1, a] = leftover;

			while (dt > dt1) {
				lst.push([dt1, a]);
				dt = dt - dt1;
				[dt1, a] = await this.run();
			}
			leftover = (dt == dt1) ? null : [dt1-dt, a];

			lst.push([dt,a]);

			return f(lst);
		};

		return new Behavior (h);
	}

	// convert an Event Signal of batches to an Event Signal of samples
	//
	// unbatch :: Signal (Time, [a]) -> Signal (Time, a)
	unbatch = _ => {
		let leftover = null;

		let h = async _ => {
			if (leftover == null) { leftover = await this.run(); }
			let [dt, lst] = leftover;

			const a = lst.shift();

			if (lst.length == 0) { leftover = null; }

			return [dt, a];	
		}
		return new Signal(h);
	}
}

/*
 * The behavior class -- also imperative like the Signal class
 *
 * The run function only passes the data 'a', not a pair (a, Behavior a), to its callback parameter, 
 *
 * A behavior object should be reused to generate the next value.
 */
class Behavior {
	// run :: Time -> (a -> IO()) -> IO()
	// run :: Time -> Promise a
	constructor(run) {
		this.run = run;
	}

	static pure = a => new Behavior(_ => Promise.resolve(a))

	// f <$> this
	fmap = f => new Behavior(dt => this.run(dt).then(x => f(x)))

	// this <*> bx
	app = bx => new Behavior(dt => Promise.all([this.run(dt), bx.run(dt)]).then(([f,x]) => f(x)))

	// run 'this' behavior as a stream with added 'delay' between events and sampling period 'dt' 
	reactimate = delay => dt => {
		const h = AsyncM.timeout(delay).bind(_ =>
			AsyncM.ifAlive.bind(_ =>
				AsyncM.liftIO_(this.run(dt)).bind(a =>
					AsyncM.pure(Stream.next(Maybe.just([dt, a]), h))
				)
			)
		)

		return Stream.next(Maybe.nothing, h)
	}

	// convert a behavior to an Event Signal of batches with 'size' number of samples and 'dt' sampling period 
	//
	// batch :: Behavior a -> Time -> Int -> Signal (Time, [a])
	batch = dt => size => new Signal(
		async _ => {
			let batch = [];

			for(let i = 0; i < size; i++) {
				const x = await this.run(dt);

				batch[i] = x;
			}
			return [dt, batch];
		}
	)


	// upsample :: Behavior a -> Int -> Behavior [a]
	upsample = factor => new Behavior(
		dt => this.run(dt*factor).then(a => Array(factor).fill(a))
	)
	
	// downsample  :: Behavior a -> Int -> ([(Int, a)] -> a) -> Behavior a 
	downsample = factor => summary => new Behavior(
		async dt => {
			const dt1 = dt/factor
			let lst = [];

			for(let i = 0; i < factor; i++) {
				let x = await this.run(dt1);
				lst[i] = [dt1, x];
			}
			return summary(lst);
		}
	)
	

	// convert a Behavior to an Event Signal of batches with sampling period 'dt', 
	// where each batch is a sliding window created with specified 'size' and 'stride'
	//
	// windowing :: Behavior a -> Int -> Int -> Time -> Event [a]
	windowing = size => stride => dt => {
		const _lst = []; // Hack: stores the temporary window in shared variable '_lst' 

		return new Signal(async _ => {
			if (_lst.length == 0) {
				// make a full window first
				for(let i = 0; i < size; i++) {
					let a = await this.run(dt);
					_lst.push(a);
				}
			}
			else {
				// make a new window for each stride
				for(let i = 0; i < stride; i++) {
					let a = await this.run(dt);
					_lst.push(a); // push new data at the end
					_lst.shift(); // pop old data in the front 
				}
			}
			return [dt*stride, _lst];
		})
	}
}


/* ***********************************************************************************************
 *                       Tests
 * ***********************************************************************************************
 */

/*
const tm1 = AsyncM.interval(10, 100, x=>console.log(x));
const tm2 = AsyncM.timeout(1000)

const m1 = AsyncM.timeout (100).bind(_ => AsyncM.pure(1))
const m2 = AsyncM.timeout (200).bind(_ => AsyncM.pure(2))
const tm3 = AsyncM.any(m1)(m2)

tm1.run(Progress.nil());
*/

// Stream.interval(100, 5).run(x => console.log(x)).run(Progress.nil())(x=>x);

const s1 = Stream.interval(100,5);
const s2 = Stream.interval(50,10);

// s1.fmap(x => x*10).run(x => console.log(x)).run(Progress.nil())(x=>x);
// s1.bind (x => Stream.pure(x*10)).run(x => console.log(x)).run(Progress.nil())(x=>x);

const t0 = s1.bind(x => s2.bind(y => Stream.pure([x,y])))

const t1 = s1.multicast().bind(s11 =>
           s2.multicast().bind(s21 =>
             s11.bind(x => 
	     s21.bind(y => 
	       Stream.pure([x,y])
	     ))
           ))

const t2 = s1.multicast().bind(s11 =>
           s2.multicast().bind(s21 =>
             Stream.pure(a=>b=>[a,b]).app(s11).app(s21)
           ))

const t3 = s1.fmap(a=>b=>[a,b]).combineLatest(Stream.pure(10))

const t4 = Stream.pure(a=>[a]).combineLatest(s2)

const t5 = s1.fmap(a=>b=>[a,b]).combineLatest(s2)

const t6 = s1.zip(s2)

const t7 = AsyncM.timeout(50).repeatS().take(5)

const t8 = s2.drop(5).take(5) // due to the leading Nothing event, we always miss one -- not sure how to fix

const t9 = Stream.interval_(100, 10)

const t10 = s2.stop(200)

const t11 = s2.fmap(x => c => x+c).accumulate(0)

const t12 = s2.until(AsyncM.timeout(200).fmap(_ => s1))

const t13 = s1.bind(x => AsyncM.timeout(50).fmap(_=>x).liftS())

const t14 = s1.fmap(x => AsyncM.timeout(500).fmap(_=>x)).fetch()

const t15 = Stream.request(n => AsyncM.timeout(n).fmap(_=>'data'))(500)(10).take(10)

// test adjusting sampling rate for data requests
const req_fun = dt => Stream.forever(10)
			    .fmap(_ => { 
				    const dt1 = Math.round(Math.random()*dt); 
				    return AsyncM.timeout(dt1).fmap(_ => dt1) 
			    }) 

const t16 = Stream.control(req_fun)(200)(20)(b => t => Math.round(b ? t/1.1 : t*1.1)).take_(200) 

// test reactimate signal
const t17 = s1.push2pull().liftS().bind(g => g.reactimate(20))

// a summary function based on weighted average
const avg = lst => {
	let t = 0, sum = 0;
	for(const [dt, a] of lst) {
		t = t + dt;
		sum = sum + a*dt;
	}
	return sum/t;
}
// test stepper
const t18 = s2.fmap(x=>[50,x]) 		// s2 is a stream with dt = 50ms
	.until(
		AsyncM.timeout(200).fmap(_=>	// switch fter 200 ms 
		s1.fmap(x=>[100,x]))	// s1 is a stream with dt = 100ms  
	)
	.push2pull().liftS() 		// convert to event
	.bind(g => 
		g.stepper(avg) 		// convert to behavior
		.reactimate(10)(40) 	// run it with 10m delay and 40ms sample-period
	)

// test unbatch
const t19 = s2.fmap(x => [50, Array(x).fill(x)]) // a stream of (Time, array)
	.push2pull().liftS()		// convert to event
	.bind(g => 
		g.unbatch() 		// unbatch
		.reactimate(10)		// run it with 10ms delay
	)
// test downsample
const t20 = s2.fmap(x=>[50,x])
	.push2pull().liftS()
	.bind(g => 
		g.stepper(avg)		// convert to a behavior
		.fmap(x => x*10)	// times 10
		.downsample(2)(avg)	// downsample by a factor of 2
		.reactimate(10)(100)	// run it with 10ms delay and 100ms sample-period
	)
// test windowing
const t21 = s2.fmap(x => [50, Array(5).fill(x)]) // a stream of batches
	.push2pull().liftS()		// convert to an event of batches
	.bind(g =>
		g.unbatch()		// unbatch the event
		.stepper(avg)		// convert to a behavior
		.windowing(5)(2)(50)	// make a window of size 5 and stride 2 with 50ms sample-period
		.reactimate(10)
	)
// test behavior <*>
const se1 = s1.fmap(x => [100,x]).push2pull().liftS()
const se2 = s2.fmap(x => [50, x]).push2pull().liftS()
const t22 = se1.bind(e1 => 
		se2.bind(e2 => {
			const b1 = e1.stepper(avg)
			const b2 = e2.stepper(avg)
			const b = Behavior.pure(x=>y=>[x,y]).app(b1).app(b2)
			return b.reactimate(10)(25);
		}))

const t23 = s2.fmap(x => [45, x]).speedControl(200)(r => (r > 0.9) ? 0 : -1)
// t23.run(Progress.nil()).then(x => console.log(x))


// test batch
const t24 = Stream.interval(1000,10).fmap(x => [10, Array(1000).fill(x)]) // a stream of (Time, Number)
	.push2pull().liftS()		// convert to batch event
	.bind(g => g.unbatch()          // convert to sample event 
		.stepper(avg) 		// convert to behavior
		.batch(100)(100)        // convert to batch
		.reactimate(1)		// run it with 1ms delay
	)

// test zip
const t25 = Stream.interval(100,30).multicast().bind(s1 =>
		Stream.interval(300,10).multicast().bind(s2 => 
			s1.zip(s2)))

// test skip
const t26 = s2.skip(200)

// The first 'run' returns an 'AsyncM' and the second 'run' executes the 'AsyncM'.
t5.run(x => console.log(x)).run(Progress.nil());

